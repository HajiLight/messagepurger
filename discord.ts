/*
 * MessagePurger — the Discord adapter: channel resolution, history paging and deletion.
 * Everything that touches the network lives here; nothing else does.
 * Copyright (C) 2026 HajiLight
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelStore, RestAPI, UserStore } from "@webpack/common";

import {
    type ChatMessage,
    classifyDeleteStatus,
    dateFromSnowflake,
    type DeleteResult,
    hasCaptchaKey,
    type PurgeFilters,
    pageStep,
    randomDelay,
    snowflakeFromDate
} from "./core";

export type ChannelKind = "dm" | "group" | "guild" | "other";

export interface ResolvedTarget {
    channelId: string;
    kind: ChannelKind;
    /** What to show the user: the other person's name, or the channel name. */
    label: string;
}

const ID_PATTERN = /^\d{15,20}$/;
const PAGE_SIZE = 100;
const MAX_FETCH_RATE_LIMIT_RETRIES = 3;
/**
 * Paging is throttled too: 19 k messages is ~200 pages, and walking them at 250 ms looks like a
 * machine reading. One page per 0.6–1.2 s costs about three minutes per archive and never tripped a
 * limit.
 */
const PAGE_DELAY_MIN_MS = 600;
const PAGE_DELAY_MAX_MS = 1200;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0 || signal?.aborted) return Promise.resolve();

    return new Promise<void>(resolve => {
        const onAbort = () => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function extractErrorBody(payload: any): unknown {
    const body = payload?.body;
    if (typeof body === "string" && body.trim() !== "") {
        try {
            return JSON.parse(body);
        } catch {
            return body;
        }
    }
    if (body !== undefined && body !== null) {
        if (typeof body !== "object" || Array.isArray(body) || Object.keys(body).length > 0) {
            return body;
        }
    }
    if (typeof payload?.text === "string" && payload.text.trim() !== "") {
        try {
            return JSON.parse(payload.text);
        } catch {
            return undefined;
        }
    }
    return body;
}

function extractRetryAfter(payload: any, parsedBody: unknown): number | undefined {
    if (typeof payload?.retryAfter === "number" && Number.isFinite(payload.retryAfter)) {
        return payload.retryAfter;
    }
    if (parsedBody !== null && typeof parsedBody === "object") {
        const bodyRetry = (parsedBody as { retry_after?: unknown }).retry_after;
        if (typeof bodyRetry === "number" && Number.isFinite(bodyRetry)) return bodyRetry;
    }
    return undefined;
}

function kindOf(type: unknown): ChannelKind {
    switch (type) {
        case 1: return "dm";
        case 3: return "group";
        case 0:
        case 5: return "guild";
        default: return "other";
    }
}

/**
 * Accepts a user ID (resolved to the existing private chat) or a channel ID directly.
 * Never guesses: an unknown ID is an error, not a silent "nothing found".
 */
export function resolveTarget(target: string): ResolvedTarget {
    const id = target.trim();

    if (!ID_PATTERN.test(id)) {
        throw new Error("Enter a Discord ID (digits only). Right-click a user or channel and use Copy ID.");
    }

    const channel = ChannelStore?.getChannel(id);

    if (channel) {
        const kind = kindOf(channel.type);
        let label: string = channel.name ?? id;

        if (kind === "dm") {
            const recipientId = channel.recipients?.[0];
            const user = recipientId ? UserStore?.getUser(recipientId) : undefined;
            label = user?.globalName || user?.username || label;
        }

        return { channelId: id, kind, label };
    }

    const dmChannelId = ChannelStore?.getDMFromUserId(id);

    if (dmChannelId) {
        const user = UserStore?.getUser(id);
        return {
            channelId: dmChannelId,
            kind: "dm",
            label: user?.globalName || user?.username || dmChannelId
        };
    }

    throw new Error("No channel and no private chat found for that ID. Open the chat once in Discord, then retry.");
}

function mapMessage(raw: any): ChatMessage {
    return {
        id: String(raw.id),
        authorId: String(raw.author?.id ?? "0"),
        authorName: raw.author?.globalName || raw.author?.username || "unknown",
        timestamp: Date.parse(raw.timestamp),
        editedTimestamp: raw.edited_timestamp ? Date.parse(raw.edited_timestamp) : undefined,
        content: raw.content ?? "",
        attachments: (raw.attachments ?? []).map((attachment: any) => ({
            name: attachment.filename ?? "file",
            url: attachment.url ?? "",
            size: attachment.size ?? 0,
            contentType: attachment.content_type
        })),
        embedCount: (raw.embeds ?? []).length,
        type: typeof raw.type === "number" ? raw.type : 0,
        hasCall: raw.call
            && (Array.isArray(raw.call.participants) || typeof raw.call.ended_timestamp === "string")
            ? true
            : undefined,
        replyToAuthor: raw.referenced_message?.author?.globalName
            ?? raw.referenced_message?.author?.username,
        pinned: Boolean(raw.pinned)
    };
}

export interface FetchOptions {
    channelId: string;
    filters: PurgeFilters;
    /** 0 = no limit. */
    maxMessages?: number;
    /** Page delay range, randomised: paging is throttled like deleting is. */
    pageDelayMinMs?: number;
    pageDelayMaxMs?: number;
    isCancelled?: () => boolean;
    signal?: AbortSignal;
    onProgress?: (state: { pages: number; messages: number; oldest?: number }) => void;
}

/**
 * Walk backwards from the end of the selected range until the range's start is reached.
 *
 * The cursor is a snowflake computed from `filters.to`, so a run for "the whole of 2024" starts at
 * 2025-01-01 and never fetches 2022 or 2023. Measured: this cursor works even though no message has
 * that ID.
 */
export async function fetchWindow(options: FetchOptions): Promise<ChatMessage[]> {
    const {
        channelId, filters, maxMessages = 0, pageDelayMinMs = PAGE_DELAY_MIN_MS, pageDelayMaxMs = PAGE_DELAY_MAX_MS,
        isCancelled, signal, onProgress
    } = options;

    const collected: ChatMessage[] = [];
    let cursor = filters.to === undefined ? undefined : snowflakeFromDate(filters.to + 1);
    // The `to` cursor is synthetic: it can name an ID that no message has, so the first page may
    // legitimately contain one message equal to it. Only a cursor that came from a page of this
    // scan may end the loop.
    let cursorIsApiId = false;
    let pages = 0;
    let currentPageDelayMin = Math.max(0, pageDelayMinMs);
    let currentPageDelayMax = Math.max(0, pageDelayMaxMs);
    const cancelled = () => Boolean(isCancelled?.() || signal?.aborted);

    for (;;) {
        if (cancelled()) break;
        if (maxMessages > 0 && collected.length >= maxMessages) break;

        const url = `/channels/${channelId}/messages?limit=${PAGE_SIZE}`
            + (cursor === undefined ? "" : `&before=${cursor}`);

        let payload: any;
        let threw = false;

        for (let retries = 0; ; retries++) {
            if (cancelled()) return collected;

            threw = false;
            try {
                payload = await RestAPI.get({ url });
            } catch (error: any) {
                payload = error;
                threw = true;
            }

            const status = payload?.status;
            if (status === 400 && hasCaptchaKey(extractErrorBody(payload))) {
                throw new Error("Discord requested a captcha — reading aborted to protect your account.");
            }

            if (status === 429) {
                if (cancelled()) return collected;
                if (retries >= MAX_FETCH_RATE_LIMIT_RETRIES) {
                    throw new Error(`Rate limited while reading history (page ${pages + 1}). Try again in a moment.`);
                }

                const parsedBody = extractErrorBody(payload);
                const rawRetryAfter = extractRetryAfter(payload, parsedBody);
                const baseWaitMs = rawRetryAfter !== undefined && rawRetryAfter >= 0
                    ? Math.round(rawRetryAfter * 1000)
                    : 1000 * (2 ** retries);
                const waitMs = baseWaitMs + randomDelay(1000, 2000);

                if (currentPageDelayMax > 0) {
                    currentPageDelayMin = Math.min(4000, Math.round(currentPageDelayMin * 1.5));
                    currentPageDelayMax = Math.min(6000, Math.round(currentPageDelayMax * 1.5));
                }

                await sleep(waitMs, signal);
                if (cancelled()) return collected;
                continue;
            }

            if (threw) {
                if (payload instanceof Error || typeof payload?.message === "string") throw payload;
                const parsedBody = extractErrorBody(payload) as { message?: unknown } | undefined;
                const detail = typeof parsedBody?.message === "string" ? `: ${parsedBody.message}` : "";
                throw new Error(
                    typeof status === "number"
                        ? `History request failed (HTTP ${status}${detail}).`
                        : "History request failed."
                );
            }
            if (typeof status === "number" && status >= 400) {
                const parsedBody = extractErrorBody(payload) as { message?: unknown } | undefined;
                const detail = typeof parsedBody?.message === "string" ? `: ${parsedBody.message}` : "";
                throw new Error(`History request failed (HTTP ${status}${detail}).`);
            }
            break;
        }

        const body = payload?.body;

        // An unexpected shape is an error, not the end of the history: silently breaking here
        // would cut the backup short while still reporting success.
        if (!Array.isArray(body)) {
            throw new Error(`Unexpected history response (page ${pages + 1}). Try again in a moment.`);
        }

        if (body.length === 0) break;

        for (const raw of body) collected.push(mapMessage(raw));

        pages++;
        const oldest = body[body.length - 1];
        onProgress?.({ pages, messages: collected.length, oldest: dateFromSnowflake(String(oldest.id)) });

        // Stop once the page we just read already starts before the requested range.
        if (filters.from !== undefined && dateFromSnowflake(String(oldest.id)) < filters.from) break;

        const step = pageStep(body, cursor, cursorIsApiId);
        if (step.kind === "end") break;
        if (step.kind === "error") throw new Error(step.message);

        cursor = step.cursor;
        cursorIsApiId = true;
        if (currentPageDelayMax > 0) {
            await sleep(randomDelay(currentPageDelayMin, currentPageDelayMax), signal);
            if (cancelled()) break;
        }
    }

    return collected;
}

/**
 * One message, one request. Status codes only (plus `captcha_key` detection on HTTP 400) —
 * Discord localises the message text (e.g. "Unknown Message"), so keying on localised strings
 * would break for other client languages.
 */
export async function deleteMessage(channelId: string, messageId: string): Promise<DeleteResult> {
    try {
        const response = await RestAPI.del(`/channels/${channelId}/messages/${messageId}`);

        // A missing status is not a success. Counting it as one would hide a deletion that never
        // happened, so it is reported as failed and shows up in the counters.
        if (response?.status === undefined) return { outcome: "failed" };

        const parsedBody = extractErrorBody(response);
        return classifyDeleteStatus(response.status, extractRetryAfter(response, parsedBody), parsedBody);
    } catch (error: any) {
        const parsedBody = extractErrorBody(error);
        return classifyDeleteStatus(error?.status, extractRetryAfter(error, parsedBody), parsedBody);
    }
}

export function selfId(): string {
    return String(UserStore?.getCurrentUser()?.id ?? "");
}
