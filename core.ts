/*
 * MessagePurger — pure logic: filters, queue selection, export formatting and the pacing model.
 * No Vencord imports, no network, no DOM, so everything here is unit tested.
 * Copyright (C) 2026 HajiLight
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type AttachmentMode = "any" | "only" | "without";

/** One message, from either side of the conversation. */
export interface ChatMessage {
    id: string;
    authorId: string;
    authorName: string;
    /** Epoch ms. */
    timestamp: number;
    /** Epoch ms, set when the message was edited. */
    editedTimestamp?: number;
    content: string;
    attachments: AttachmentInfo[];
    embedCount: number;
    /** Author of the message this one replies to, when known. */
    replyToAuthor?: string;
    /** Whether the message is pinned in the channel. */
    pinned?: boolean;
}

export interface AttachmentInfo {
    name: string;
    url: string;
    size: number;
    contentType?: string;
}

export interface PurgeFilters {
    /** Epoch ms, inclusive. */
    from?: number;
    /** Epoch ms, inclusive. */
    to?: number;
    /** Lower case substring of the message content. */
    contains?: string;
    attachmentMode: AttachmentMode;
}

export interface RawFilters {
    fromDate?: string;
    toDate?: string;
    contains?: string;
    attachmentMode?: string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?$/;

/**
 * Turn a user supplied date into epoch ms. A bare date covers the whole day: `endOfDay` picks
 * 23:59:59.999 instead of 00:00:00.000, so "to 2024-03-05" includes messages sent that day.
 */
export function parseDateBound(value: string | undefined, endOfDay: boolean): number | undefined {
    const trimmed = (value ?? "").trim();
    if (trimmed === "") return undefined;

    if (!DATE_ONLY.test(trimmed) && !DATE_TIME.test(trimmed)) {
        throw new Error(`Invalid date: "${trimmed}". Use YYYY-MM-DD or YYYY-MM-DDTHH:mm.`);
    }

    // A regex only proves the shape. 2024-02-30 and 2023-02-29 have that shape and still do not
    // exist; JavaScript silently rolls them into March, which would quietly widen the range.
    const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
        trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/) ?? [];
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const probe = new Date(year, month - 1, day);

    if (probe.getFullYear() !== year || probe.getMonth() + 1 !== month || probe.getDate() !== day) {
        throw new Error(`Invalid date: "${trimmed}" is not a real calendar date.`);
    }

    if (
        hourText !== undefined
        && (Number(hourText) > 23 || Number(minuteText) > 59 || (secondText !== undefined && Number(secondText) > 59))
    ) {
        throw new Error(`Invalid time: "${trimmed}". Hours are 0-23 and minutes/seconds are 0-59.`);
    }

    const normalised = trimmed.replace(" ", "T");
    const date = new Date(DATE_ONLY.test(trimmed)
        ? `${normalised}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`
        : normalised);

    if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: "${trimmed}"`);

    return date.getTime();
}

export function normaliseFilters(raw: RawFilters): PurgeFilters {
    const from = parseDateBound(raw.fromDate, false);
    const to = parseDateBound(raw.toDate, true);

    if (from !== undefined && to !== undefined && from > to) {
        throw new Error("The \"from\" date is after the \"to\" date.");
    }

    const contains = (raw.contains ?? "").trim().toLowerCase();
    const attachmentMode: AttachmentMode =
        raw.attachmentMode === "only" || raw.attachmentMode === "without" ? raw.attachmentMode : "any";

    return {
        from,
        to,
        contains: contains === "" ? undefined : contains,
        attachmentMode
    };
}

/**
 * Applies to both sides of the conversation: a backup is a backup of the whole chat.
 * Whether a message may be deleted is a separate question — see `isDeletable`.
 */
export function matchesFilters(message: ChatMessage, filters: PurgeFilters): boolean {
    // An unreadable timestamp cannot be shown to be inside a range, so it is treated as outside.
    if (!Number.isFinite(message.timestamp)) return false;

    if (filters.from !== undefined && message.timestamp < filters.from) return false;
    if (filters.to !== undefined && message.timestamp > filters.to) return false;

    if (filters.contains !== undefined && !message.content.toLowerCase().includes(filters.contains)) return false;

    const hasAttachment = message.attachments.length > 0;
    if (filters.attachmentMode === "only" && !hasAttachment) return false;
    if (filters.attachmentMode === "without" && hasAttachment) return false;

    return true;
}

/**
 * Who may delete what, in one place.
 *
 * Only the author can delete a message — that is the rule Discord enforces with `403` for anyone
 * else's message in a private chat. Pinned messages are deleted too unless `excludePinned` is on,
 * because a pin is a deliberate marker the user left on a message; they stay in the backup either
 * way. There is deliberately **no** whitelist of message types here: pin notices (type 6) delete
 * with `204`, and if Discord refuses any other type, the run counts it as `failed` without retrying
 * a `4xx`.
 */
export function isDeletable(message: ChatMessage, selfId: string, excludePinned = false): boolean {
    if (message.authorId !== selfId) return false;
    if (excludePinned && message.pinned) return false;
    return true;
}

/** Everything that goes into a backup: both sides, oldest first, de-duplicated by id. */
export function buildBackupSet(messages: readonly ChatMessage[], filters: PurgeFilters): ChatMessage[] {
    const unique = new Map<string, ChatMessage>();

    for (const message of messages) {
        // A page boundary can repeat a message when new ones arrive mid-scan.
        if (!unique.has(message.id) && matchesFilters(message, filters)) unique.set(message.id, message);
    }

    return [...unique.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/** Everything that may be deleted: the same filters, plus "written by me", oldest first, capped. */
export function buildDeleteQueue(
    messages: readonly ChatMessage[],
    filters: PurgeFilters,
    selfId: string,
    limit: number,
    excludePinned = false
): ChatMessage[] {
    const unique = new Map<string, ChatMessage>();

    for (const message of messages) {
        // Both conditions come from named rules, so a fix to either cannot miss this call site.
        if (!isDeletable(message, selfId, excludePinned) || !matchesFilters(message, filters)) continue;
        if (!unique.has(message.id)) unique.set(message.id, message);
    }

    const deletable = [...unique.values()].sort((a, b) => a.timestamp - b.timestamp);

    return limit > 0 ? deletable.slice(0, limit) : deletable;
}

/** What a run would do: which chat, which range, which cap, which mode. */
export interface RunContext {
    channelId: string;
    /** What to show the user: the other person's name, or the channel name. Not compared. */
    label: string;
    limit: number;
    mode: string;
    filters: PurgeFilters;
    /** Whether pinned messages are excluded from deletion (defaults to false). */
    excludePinned?: boolean;
}

/**
 * Do two contexts describe the same operation?
 *
 * The confirmation must name a specific run, not "whatever the settings say right now": a preview
 * can outlive a change of chat, of cap or of mode, and confirming a stale one deletes something
 * nobody was shown.
 */
export function sameRunContext(a: RunContext | null, b: RunContext | null): boolean {
    if (a === null || b === null) return false;

    return a.channelId === b.channelId
        && a.limit === b.limit
        && a.mode === b.mode
        && (a.excludePinned ?? false) === (b.excludePinned ?? false)
        && filtersEqual(a.filters, b.filters);
}

/**
 * A paced delay from an untrusted settings value.
 *
 * `setTimeout` clamps NaN to about 1 ms, so one hand-edited `settings.json` entry would turn a
 * deliberately slow run into a burst. The floor matches the lowest the slider offers (600 ms, which
 * the ±40 % jitter takes to 360 ms); the ceiling leaves room for the back-off.
 */
export function clampDelay(value: unknown, fallback: number, minMs = 600, maxMs = 6000): number {
    // `Number(null)` and `Number("")` are both 0, which would land on the floor instead of the
    // default. A missing setting is not a request for the shortest delay.
    if (value === null || value === undefined) return fallback;

    const text = typeof value === "string" ? value.trim() : value;
    if (text === "") return fallback;

    const number = typeof text === "number" ? text : Number(text);

    if (!Number.isFinite(number)) return fallback;

    return Math.min(maxMs, Math.max(minMs, Math.round(number)));
}

/** Are two filter sets the same range and query? Used to notice settings changed after a preview. */
export function filtersEqual(a: PurgeFilters, b: PurgeFilters): boolean {
    return a.from === b.from
        && a.to === b.to
        && a.contains === b.contains
        && a.attachmentMode === b.attachmentMode;
}

/**
 * The run cap, read from a settings value that may be any shape.
 *
 * `0` means "no cap" only when it was chosen on purpose; a missing key, an empty field or a
 * negative number falls back to the default instead of silently removing the cap.
 */
export function parseRunCap(value: unknown, fallback = 300): number {
    if (value === null || value === undefined) return fallback;

    // `Number("")` is 0, which would turn an empty field into "no cap" — the exact silent
    // widening this function exists to prevent.
    const text = typeof value === "string" ? value.trim() : value;
    if (text === "") return fallback;

    const number = typeof text === "number" ? text : Number(text);

    if (!Number.isFinite(number) || number < 0) return fallback;

    // A fraction cannot come from the settings list; if one appears, it means someone edited the
    // store, and truncating it to 0 would silently mean "no cap".
    if (number > 0 && number < 1) return fallback;

    return Math.trunc(number);
}

/**
 * A random delay inside `[minMs, maxMs]`, used wherever a wait must not be a constant.
 * Constant waits are a signature: they are the first thing a bot detector looks for.
 */
export function randomDelay(minMs: number, maxMs: number, rng: () => number = Math.random): number {
    if (maxMs <= minMs) return Math.max(0, minMs);
    return Math.max(0, Math.round(minMs + rng() * (maxMs - minMs)));
}

export type DeleteOutcome = "deleted" | "gone" | "forbidden" | "rate_limited" | "captcha" | "failed";

export interface DeleteResult {
    outcome: DeleteOutcome;
    status?: number;
    /** Only for `rate_limited` and `failed`: how long Discord asked us to wait. */
    retryAfterMs?: number;
}

/** Returns true if a parsed Discord error body indicates a captcha challenge (`captcha_key`). */
export function hasCaptchaKey(body: unknown): boolean {
    if (body === null || typeof body !== "object") return false;
    const key = (body as { captcha_key?: unknown }).captcha_key;
    return Array.isArray(key) ? key.length > 0 : Boolean(key);
}

/**
 * What a delete attempt means, decided by HTTP status (plus `captcha_key` detection on HTTP 400).
 *
 * Discord's localised error text changes without notice, so messages are not parsed; only the
 * structured `captcha_key` field on HTTP 400 is inspected to abort immediately.
 */
export function classifyDeleteStatus(
    status: number | undefined,
    retryAfterSeconds?: number,
    body?: unknown
): DeleteResult {
    if (status === 400 && hasCaptchaKey(body)) {
        return { outcome: "captcha", status: 400 };
    }

    switch (status) {
        case 200:
        case 204:
            return { outcome: "deleted", status };
        case 404:
            return { outcome: "gone", status };
        case 403:
            return { outcome: "forbidden", status };
        case 429:
            return { outcome: "rate_limited", status, retryAfterMs: Math.round((retryAfterSeconds ?? 1) * 1000) };
        default:
            return {
                outcome: "failed",
                status,
                retryAfterMs: retryAfterSeconds === undefined ? undefined : Math.round(retryAfterSeconds * 1000)
            };
    }
}

/** What the paging loop should do after a page. */
export type PageStep =
    | { kind: "end" }
    | { kind: "continue"; cursor: string }
    | { kind: "error"; message: string };

/**
 * Decides whether history paging may continue after a page.
 *
 * `cursor` is the ID the page was requested with, and `cursorIsApiId` says whether that ID came
 * from a page of this scan. The first page can use a synthetic cursor derived from `toDate`, which
 * no message needs to have, so the one-item echo only ends a scan when the cursor really is a
 * message that was already read.
 */
export function pageStep(
    body: Array<{ id: string | number }>,
    cursor: string | undefined,
    cursorIsApiId: boolean
): PageStep {
    if (body.length === 0) return { kind: "end" };

    const nextCursor = String(body[body.length - 1].id);

    // A page that contains only the cursor itself is an echo, not a loop: that is the last message
    // already read. Correct for a server that honours `before` inclusively.
    if (cursorIsApiId && body.length === 1 && nextCursor === cursor) return { kind: "end" };

    // Otherwise progress must be strictly backwards. An equal or larger cursor means the server
    // ignored `before`, and continuing would collect the same pages forever.
    if (cursorIsApiId && cursor !== undefined && BigInt(nextCursor) >= BigInt(cursor)) {
        return {
            kind: "error",
            message: "History paging stopped making progress — the cursor did not move backwards. Try again in a moment."
        };
    }

    return { kind: "continue", cursor: nextCursor };
}

export interface ArmGateOptions {
    /** How long an armed confirmation stays valid. */
    confirmWindowMs: number;
    /** Ignore a confirming click that arrives sooner than this after arming. */
    minimumGapMs: number;
}

export const DEFAULT_ARM_GATE: ArmGateOptions = {
    confirmWindowMs: 60_000,
    minimumGapMs: 1500
};

/**
 * The two-step confirmation, as a testable state machine.
 *
 * The minimum gap exists because a double click is one intention but two events: without it,
 * "Start" would arm and immediately confirm, deleting without anybody reading the count.
 */
export class ArmGate {
    private readonly options: ArmGateOptions;
    private armedAt: number | null = null;

    constructor(options: ArmGateOptions = DEFAULT_ARM_GATE) {
        this.options = options;
    }

    /**
     * Feed one press of the confirm button.
     * `arm` — show the confirmation prompt and wait; `soon` — ignore a too-fast second press;
     * `confirm` — the user really pressed twice, go ahead.
     */
    press(now: number = Date.now()): "arm" | "soon" | "confirm" {
        if (this.armedAt === null) {
            this.armedAt = now;
            return "arm";
        }

        const elapsed = now - this.armedAt;

        if (elapsed < this.options.minimumGapMs) return "soon";

        if (elapsed > this.options.confirmWindowMs) {
            this.armedAt = now;
            return "arm";
        }

        this.armedAt = null;
        return "confirm";
    }

    get armedUntil(): number {
        return this.armedAt === null ? 0 : this.armedAt + this.options.confirmWindowMs;
    }

    get isArmed(): boolean {
        return this.armedAt !== null;
    }

    reset(): void {
        this.armedAt = null;
    }
}

export interface PacerOptions {
    /** Delay between two deletions at 100% confidence. */
    baseDelayMs: number;
    /** Fraction of the base delay used as +/- jitter. 0.4 = +/-40%. */
    jitter: number;
    /** Long pause after this many deletions, randomly picked in the range. */
    pauseEveryMin: number;
    pauseEveryMax: number;
    pauseMinMs: number;
    pauseMaxMs: number;
    /** Upper bound the base delay may grow to after rate limits. */
    ceilingMs: number;
}

export const DEFAULT_PACER: PacerOptions = {
    baseDelayMs: 1400,
    jitter: 0.4,
    pauseEveryMin: 15,
    pauseEveryMax: 30,
    pauseMinMs: 6000,
    pauseMaxMs: 18000,
    ceilingMs: 4000
};

/**
 * Decides how long to wait before the next deletion.
 *
 * Measured on a real chat: twelve deletes issued back to back finished in 4.3 s with no 429, so the
 * transport queues invisibly and the ceiling is far above this pace. The pacing is therefore about
 * being deliberate, not about avoiding a limit — but it is also the only safety margin available,
 * because the client exposes no rate limit headers.
 */
export class Pacer {
    private readonly options: PacerOptions;
    private base: number;
    private sincePause = 0;
    private pauseAt: number;

    constructor(options: PacerOptions = DEFAULT_PACER, rng: () => number = Math.random) {
        this.options = options;
        this.base = options.baseDelayMs;
        this.pauseAt = this.pickPauseAt(rng);
    }

    private pickPauseAt(rng: () => number): number {
        const { pauseEveryMin, pauseEveryMax } = this.options;
        return Math.round(pauseEveryMin + rng() * (pauseEveryMax - pauseEveryMin));
    }

    /** Delay before the next deletion, in milliseconds. */
    next(rng: () => number = Math.random): number {
        if (this.sincePause >= this.pauseAt) {
            this.sincePause = 0;
            this.pauseAt = this.pickPauseAt(rng);
            return this.options.pauseMinMs + rng() * (this.options.pauseMaxMs - this.options.pauseMinMs);
        }

        this.sincePause++;
        const spread = 1 + this.options.jitter * (2 * rng() - 1);
        return Math.round(this.base * spread);
    }

    /**
     * Called on HTTP 429. Returns how long to wait, and slows the rest of the run down.
     *
     * It never *speeds up*: a base above the ceiling (possible only through a hand-edited
     * settings file) must not be lowered by the first rate limit, or the plugin would answer
     * "too fast" by going faster.
     */
    onRateLimited(retryAfterMs: number, rng: () => number = Math.random): number {
        this.base = Math.max(this.base, Math.min(this.base * 1.2, this.options.ceilingMs));
        return Math.round(retryAfterMs + 1000 + rng() * 2000);
    }

    get currentBase(): number {
        return this.base;
    }
}

/**
 * Discord message IDs are snowflakes: `((timestamp_ms - epoch) << 22) + worker + counter`.
 * Because the high bits are the timestamp, an ID that belongs to no message is still a valid
 * cursor — measured: a cursor for 2025-01-01 returned, as its newest message, 2024-12-31T23:59:37.
 * That is what lets a run jump into "the whole of 2024" without paging through 2022 and 2023.
 */
export const SNOWFLAKE_EPOCH = 1420070400000;

export function snowflakeFromDate(epochMs: number): string {
    if (!Number.isFinite(epochMs)) throw new Error("Invalid date: the timestamp is not a number.");

    if (epochMs < SNOWFLAKE_EPOCH) {
        throw new Error("Discord has no messages before 2015-01-01.");
    }

    return ((BigInt(Math.trunc(epochMs)) - BigInt(SNOWFLAKE_EPOCH)) << 22n).toString();
}

export function dateFromSnowflake(id: string): number {
    return Number(BigInt(id) >> 22n) + SNOWFLAKE_EPOCH;
}

/** Local `YYYY-MM-DD HH:mm`, no seconds: the format a person reads. */
export function formatTimestamp(epochMs: number): string {
    const date = new Date(epochMs);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
        + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** One JSON object per line: streamable, greppable, and no escaping of embedded newlines. */
export function formatJsonl(messages: readonly ChatMessage[]): string {
    const lines = messages.map(message => JSON.stringify({
        id: message.id,
        timestamp: new Date(message.timestamp).toISOString(),
        authorId: message.authorId,
        authorName: message.authorName,
        editedAt: message.editedTimestamp ? new Date(message.editedTimestamp).toISOString() : undefined,
        replyToAuthor: message.replyToAuthor,
        content: message.content,
        attachments: message.attachments.map(attachment => ({
            name: attachment.name,
            size: attachment.size,
            contentType: attachment.contentType,
            // Expires: the CDN signature in the URL is time limited.
            url: attachment.url
        })),
        embedCount: message.embedCount
    }));

    return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** Human readable, same information, no JSON syntax. */
export function formatTxt(
    messages: readonly ChatMessage[],
    formatDate: (epochMs: number) => string = formatTimestamp
): string {
    const blocks = messages.map(message => {
        const edited = message.editedTimestamp ? " (edited)" : "";
        const reply = message.replyToAuthor ? ` ↪ ${message.replyToAuthor}` : "";
        const head = `[${formatDate(message.timestamp)}] ${message.authorName}${reply}${edited}`;
        const body = message.content === "" ? "" : `\n${message.content}`;
        const files = message.attachments.length === 0
            ? ""
            : `\n${message.attachments.map(a => `    [file] ${a.name} (${humanSize(a.size)})`).join("\n")}`;

        return `${head}${body}${files}`;
    });

    return blocks.length === 0 ? "" : `${blocks.join("\n\n")}\n`;
}

export function humanSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A file-name-safe form of a chat label.
 *
 * Letters and digits of any script survive — "ogólny" stays "ogólny" instead of becoming "og_lny",
 * and two chats whose names differ only by a diacritic must not end up as the same file. Names are
 * truncated by **code points**, because slicing a UTF-16 string can cut an astral character in half,
 * and a truncated name carries a short hash of the full label so two chats that share a long prefix
 * cannot silently overwrite each other.
 */
export function safeFileName(label: string): string {
    const clean = label.replace(/[^\p{L}\p{N}._-]+/gu, "_") || "chat";

    const points = Array.from(clean);
    if (points.length <= 40) return clean;

    return `${points.slice(0, 36).join("")}-${shortHash(clean)}`;
}

/** 6 hex digits of an FNV-1a hash, enough to separate two names that share a prefix. */
function shortHash(text: string): string {
    let hash = 0x811c9dc5;
    for (const character of text) {
        hash ^= character.codePointAt(0)!;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0").slice(0, 6);
}

/** `2024-01-01_2025-01-01` or `all-time`, for the file name. */
export function rangeLabel(filters: PurgeFilters): string {
    const day = (ms: number) => formatTimestamp(ms).slice(0, 10);
    const from = filters.from === undefined ? null : day(filters.from);
    const to = filters.to === undefined ? null : day(filters.to);

    if (from === null && to === null) return "all-time";
    return `${from ?? "start"}_${to ?? "end"}`;
}
