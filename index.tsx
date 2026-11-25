/*
 * MessagePurger — plugin definition: settings, the control panel and the run orchestration.
 * Copyright (C) 2026 HajiLight
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import definePlugin, { OptionType } from "@utils/types";
import { useEffect, useState } from "@webpack/common";

import {
    ArmGate,
    buildBackupSet,
    buildDeleteQueue,
    type ChatMessage,
    clampDelay,
    type DeleteOutcome,
    type DeleteResult,
    DEFAULT_PACER,
    filtersEqual,
    formatJsonl,
    formatTxt,
    normaliseFilters,
    Pacer,
    parseRunCap,
    type PurgeFilters,
    rangeLabel,
    safeFileName,
    type RunContext,
    sameRunContext
} from "./core";
import {
    deleteMessage,
    fetchWindow,
    resolveTarget,
    selfId
} from "./discord";

type Phase = "idle" | "scanning" | "ready" | "exporting" | "deleting" | "done" | "stopped" | "error";

interface RunState {
    phase: Phase;
    note: string;
    total: number;
    deleted: number;
    gone: number;
    forbidden: number;
    failed: number;
    throttled: number;
    /** How many messages the armed confirmation would delete. */
    queued: number;
}

const state: RunState = {
    phase: "idle",
    note: "",
    total: 0,
    deleted: 0,
    gone: 0,
    forbidden: 0,
    failed: 0,
    throttled: 0,
    queued: 0
};

const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());

let cancelRequested = false;
let sleepAbort: AbortController | null = null;
let scanAbort: AbortController | null = null;

function interruptSleep() {
    sleepAbort?.abort();
    sleepAbort = null;
    scanAbort?.abort();
    scanAbort = null;
}

function sleep(ms: number): Promise<void> {
    if (cancelRequested || ms <= 0) return Promise.resolve();

    return new Promise<void>(resolve => {
        const controller = new AbortController();
        sleepAbort = controller;

        const onAbort = () => {
            clearTimeout(timer);
            if (sleepAbort === controller) sleepAbort = null;
            resolve();
        };

        const timer = setTimeout(() => {
            controller.signal.removeEventListener("abort", onAbort);
            if (sleepAbort === controller) sleepAbort = null;
            resolve();
        }, ms);

        controller.signal.addEventListener("abort", onAbort, { once: true });
    });
}
/** One long operation at a time. A second Preview during a scan must not double the requests. */
let busy = false;
let scanned: { messages: ChatMessage[]; filters: PurgeFilters; target: { channelId: string; label: string } } | null = null;
/** What the last arming press actually promised. A confirm is only valid against this. */
let armStamp: RunContext | null = null;
/**
 * One gate for the plugin, with the defaults from core. The window is a full minute because in
 * `exportThenDelete` the first press opens two save dialogs and saving them can take longer than
 * ten seconds. What keeps it safe is the context stamp, not a short timer: a confirm is refused
 * unless the run is unchanged.
 */
const gate = new ArmGate();
/** The last backup offered, so a press after the window expires does not cost two more dialogs. */
let lastOffer: { stamp: RunContext; at: number } | null = null;
const OFFER_REUSE_MS = 10 * 60_000;

/**
 * Drops everything a failed export could still be confirmed against. Clearing the offer matters
 * as much as clearing the gate: a Start after "nothing will be deleted" must not resurrect the
 * offer an earlier, unrelated export left behind.
 */
function forgetOffer() {
    lastOffer = null;
    armStamp = null;
}
const DEFAULT_RUN_CAP = 300;
const BLOB_REVOKE_DELAY_MS = 120_000;

const settings = definePluginSettings({
    target: {
        type: OptionType.STRING,
        description: "User ID or channel ID. A user ID is resolved to the private chat you already have with them.",
        placeholder: "123456789012345678",
        default: ""
    },
    mode: {
        type: OptionType.SELECT,
        description: "What Start does",
        options: [
            { label: "Export, then delete", value: "exportThenDelete", default: true },
            { label: "Export only", value: "export" },
            { label: "Delete only (no backup)", value: "deleteOnly" }
        ]
    },
    fromDate: {
        type: OptionType.STRING,
        description: "Start of the range, YYYY-MM-DD or YYYY-MM-DDTHH:mm. Empty = the beginning of the chat.",
        placeholder: "2024-01-01",
        default: ""
    },
    toDate: {
        type: OptionType.STRING,
        description: "End of the range. Empty = now. A bare date includes the whole day.",
        placeholder: "2024-12-31",
        default: ""
    },
    contains: {
        type: OptionType.STRING,
        description: "Only messages containing this text, case insensitive. Empty = any content.",
        default: ""
    },
    attachmentMode: {
        type: OptionType.SELECT,
        description: "Filter by attachments",
        options: [
            { label: "Any message", value: "any", default: true },
            { label: "Only messages with attachments", value: "only" },
            { label: "Only messages without attachments", value: "without" }
        ]
    },
    runCap: {
        type: OptionType.SELECT,
        description: "How many of your own messages one run may delete. Never caps the backup.",
        options: [
            { label: "300 — default", value: "300", default: true },
            { label: "1 000", value: "1000" },
            { label: "3 000", value: "3000" },
            { label: "No cap — every message in the range", value: "0" }
        ]
    },
    baseDelayMs: {
        type: OptionType.SLIDER,
        description: "Base delay between deletions, in seconds. Jitter of ±40% and longer pauses are added on top.",
        markers: [600, 800, 1000, 1400, 1800, 2400, 3000, 4000],
        default: 1400,
        stickToMarkers: false,
        // Discord gives every marker label a fixed 24 px box, so "1400" wrapped its last digit
        // onto a second line. Three characters fit: 0.6 … 4.
        componentProps: {
            onMarkerRender: (v: number) => (v / 1000).toFixed(1).replace(/\.0$/, ""),
            onValueRender: (v: number) => `${(v / 1000).toFixed(1).replace(/\.0$/, "")} s`
        }
    },
    excludePinned: {
        type: OptionType.BOOLEAN,
        description: "Skip pinned messages when deleting. Off by default: pinned messages are deleted like any other. They are always kept in backups.",
        default: false
    },
    verifyAfterRun: {
        type: OptionType.BOOLEAN,
        description: "After a run, read the range again to check what is left (kept pins, refusals, new messages). Costs one extra history read per run. Transport failures are retried once at the end of every run, whether this is on or off.",
        default: true
    },
    panel: {
        type: OptionType.COMPONENT,
        component: Panel
    }
});

function saveText(name: string, text: string, mime: string) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), BLOB_REVOKE_DELAY_MS);
}

function resetRun(phase: Phase, note: string) {
    gate.reset();
    Object.assign(state, {
        phase,
        note,
        total: 0,
        deleted: 0,
        gone: 0,
        forbidden: 0,
        failed: 0,
        throttled: 0,
        queued: 0
    });
    notify();
}

/** The filters exactly as the settings describe them right now. */
function currentFilters(): PurgeFilters {
    return normaliseFilters({
        fromDate: String(settings.store.fromDate),
        toDate: String(settings.store.toDate),
        contains: String(settings.store.contains),
        attachmentMode: String(settings.store.attachmentMode)
    });
}

/**
 * Everything a run would do, read from the settings at this instant.
 *
 * Throws on a bad date, a bad ID or an unsupported channel type — the caller decides whether that
 * becomes an error in the panel or is simply refused.
 */
function currentContext(mode: string): RunContext {
    const target = resolveTarget(String(settings.store.target));

    if (target.kind !== "dm" && target.kind !== "guild") {
        throw new Error("This version handles private chats and server text channels. Group DMs and threads come later.");
    }

    return {
        channelId: target.channelId,
        label: target.label,
        limit: parseRunCap(settings.store.runCap, DEFAULT_RUN_CAP),
        mode,
        filters: currentFilters(),
        excludePinned: settings.store.excludePinned === true
    };
}

/** Reads the whole selected range. Both sides of the conversation — it is a backup, not a filter. */
async function scanCore(reason?: string): Promise<boolean> {
    scanned = null;
    armStamp = null;
    lastOffer = null;
    cancelRequested = false;
    scanAbort?.abort();
    const controller = new AbortController();
    scanAbort = controller;
    // The reason survives the progress updates, so the user can see WHY the list is being read again.
    const prefix = reason ? `${reason} ` : "";
    resetRun("scanning", `${prefix}Reading history…`);

    try {
        const context = currentContext("scan");

        const messages = await fetchWindow({
            channelId: context.channelId,
            filters: context.filters,
            // Stop must actually stop the paging, not only repaint the label.
            isCancelled: () => cancelRequested,
            signal: controller.signal,
            onProgress: progress => {
                state.note = `${prefix}Reading history… ${progress.messages} messages so far`;
                notify();
            }
        });

        if (cancelRequested) {
            resetRun("stopped", "Stopped while reading — nothing was collected, nothing will be deleted.");
            return false;
        }

        // Without the account id every message would look like "someone else's" and the preview
        // would say "nothing to delete". That is a wrong answer, not a safe one.
        const me = selfId();
        if (me === "") throw new Error("Discord has not finished loading your account — try again in a moment.");

        if (messages.length === 0) {
            resetRun("ready", `No messages found for ${context.label}. Check the IDs and the date range.`);
            return true;
        }

        const backup = buildBackupSet(messages, context.filters);
        const mine = backup.filter(message => message.authorId === me).length;

        scanned = {
            messages,
            filters: context.filters,
            target: { channelId: context.channelId, label: context.label }
        };
        Object.assign(state, {
            phase: "ready",
            note: `${context.label}: ${backup.length} messages in range — ${mine} yours, ${backup.length - mine} from the other side.`,
            total: backup.length,
            queued: 0
        });
        notify();
        return true;
    } catch (error: any) {
        if (cancelRequested) {
            resetRun("stopped", "Stopped while reading — nothing was collected, nothing will be deleted.");
            return false;
        }
        resetRun("error", String(error?.message ?? error));
        return false;
    } finally {
        if (scanAbort === controller) scanAbort = null;
    }
}

/** Preview: one scan at a time. */
async function scan(): Promise<boolean> {
    // Refuse quietly: the panel already shows the progress of the operation that is running,
    // and overwriting that note with "already working" hides what is actually happening.
    if (busy) return false;

    busy = true;
    try {
        return await scanCore();
    } finally {
        busy = false;
    }
}

async function exportCore(): Promise<boolean> {
    let context: RunContext;

    try {
        context = currentContext("export");
    } catch (error: any) {
        forgetOffer();
        resetRun("error", String(error?.message ?? error));
        return false;
    }

    // The same freshness rule as Start: exporting a preview from another chat, or from another
    // range, would give the user a file that does not describe what the panel shows.
    if (scanned !== null
        && (scanned.target.channelId !== context.channelId || !filtersEqual(scanned.filters, context.filters))) {
        scanned = null;
    }

    if (scanned === null && !(await scanCore())) return false;
    if (scanned === null) return false;

    const { target, filters, messages } = scanned;
    const backup = buildBackupSet(messages, filters);
    const base = `messages-${safeFileName(target.label)}-${rangeLabel(filters)}`;

    state.phase = "exporting";
    state.note = `Writing ${backup.length} messages…`;
    notify();

    try {
        saveText(`${base}.jsonl`, formatJsonl(backup), "application/jsonl");
        saveText(`${base}.txt`, formatTxt(backup), "text/plain");
    } catch (error: any) {
        // The gate must never stay armed after a failed export, or the next press deletes without it.
        // The remembered offer goes too: the panel just said nothing would be deleted, so the next
        // Start has to earn a fresh backup instead of silently reusing an older one.
        forgetOffer();
        resetRun("ready", `Export failed: ${String(error?.message ?? error)}. The confirmation was cleared, nothing will be deleted.`);
        return false;
    }

    state.phase = "ready";
    // The renderer cannot see the save dialogs, so this claims only what it did: it offered the files.
    state.note = `Offered ${backup.length} messages as ${base}.jsonl and ${base}.txt — save both dialogs.`;
    notify();
    return true;
}

/** Export: one export at a time. */
async function exportFiles(): Promise<boolean> {
    // Refuse quietly: the panel already shows the progress of the operation that is running,
    // and overwriting that note with "already working" hides what is actually happening.
    if (busy) return false;

    busy = true;
    try {
        return await exportCore();
    } finally {
        busy = false;
    }
}

const MAX_RATE_LIMIT_RETRIES = 3;

async function runDeletion(queue: ChatMessage[], context: RunContext, me: string): Promise<void> {
    if (scanned === null) return;
    const channelId = scanned.target.channelId;
    // Does the cap really withhold anything? Comparing the queue with the cap is not evidence:
    // a range that happens to hold exactly `limit` messages would look capped and the note about
    // "the rest" would be a lie. Count what the filters matched instead.
    const intended = buildDeleteQueue(scanned.messages, scanned.filters, me, 0, context.excludePinned ?? false).length;
    const cappedRun = intended > queue.length;
    const excludePinned = context.excludePinned ?? false;

    cancelRequested = false;
    gate.reset();
    armStamp = null;
    Object.assign(state, { phase: "deleting", deleted: 0, gone: 0, forbidden: 0, failed: 0, throttled: 0, queued: queue.length });
    notify();

    // A hand-edited settings value must not turn a slow run into a burst: `setTimeout` clamps NaN
    // to about 1 ms, which would be the opposite of the pacing this plugin promises.
    const pacer = new Pacer({
        ...DEFAULT_PACER,
        baseDelayMs: clampDelay(settings.store.baseDelayMs, DEFAULT_PACER.baseDelayMs)
    });

    /** Transport failures worth one more request. A 4xx is an answer, not a lost packet. */
    const failedIds = new Set<string>();
    /** Messages answered with a 4xx: retrying them would be pressure, not recovery. */
    const refusedIds = new Set<string>();
    /** Messages that stayed rate-limited through every allowed retry. */
    const throttledIds = new Set<string>();

    const count = (outcome: DeleteOutcome) => {
        if (outcome === "deleted") state.deleted++;
        else if (outcome === "gone") state.gone++;
        else if (outcome === "forbidden") state.forbidden++;
        else state.failed++;
    };

    /**
     * One message, with retries inside a rate limit window.
     * A 429 means "later", not "never": dropping the message would silently leave it behind.
     */
    const attempt = async (messageId: string): Promise<DeleteResult> => {
        let result = await deleteMessage(channelId, messageId);
        let retries = 0;

        while (result.outcome === "rate_limited" && retries < MAX_RATE_LIMIT_RETRIES && !cancelRequested) {
            // Waiting is not an outcome: only `record` counts a message as throttled, and only
            // when it stays that way. A 429 that is later deleted is simply a message that waited.
            notify();
            await sleep(pacer.onRateLimited(result.retryAfterMs ?? 1000));
            if (cancelRequested) break;
            retries++;
            result = await deleteMessage(channelId, messageId);
        }

        return result;
    };

    /**
     * The two reasons a run must stop immediately, shared by both passes: a captcha challenge and
     * a streak of 401/403. Applying them only to the first pass would let the retry pass walk
     * straight through a captcha that the run was supposed to honour.
     */
    let consecutiveAuthErrors = 0;
    const guard = (result: DeleteResult) => {
        if (result.outcome === "captcha") {
            throw new Error("Discord requested a captcha — deletion aborted immediately to protect your account");
        }

        const isAuthOrForbidden = result.outcome === "forbidden" || result.status === 403 || result.status === 401;
        if (isAuthOrForbidden) {
            consecutiveAuthErrors++;
            if (consecutiveAuthErrors >= 3) {
                throw new Error("Aborted after 3 consecutive HTTP 401/403 responses (circuit breaker) to protect your account");
            }
        } else {
            consecutiveAuthErrors = 0;
        }
    };

    /** Records an outcome for the counters and for the later report. */
    const record = (id: string, result: DeleteResult, retry = false) => {
        if (retry) {
            // A retried message was already counted as `failed`; move it to its real outcome.
            if (result.outcome === "deleted") { state.failed--; state.deleted++; failedIds.delete(id); }
            else if (result.outcome === "gone") { state.failed--; state.gone++; failedIds.delete(id); }
            else if (result.outcome === "forbidden") {
                state.failed--; state.forbidden++; failedIds.delete(id); refusedIds.add(id);
            } else if (result.outcome === "rate_limited") {
                // Still throttled after the retry: it was counted as `failed` by the first pass,
                // but throttling is its real outcome, so it moves to the throttled bucket.
                failedIds.delete(id);
                throttledIds.add(id);
                state.failed--;
                state.throttled++;
            } else if (result.outcome === "failed" && typeof result.status === "number" && result.status >= 400 && result.status < 500) {
                // It looked like a transport loss, then answered 4xx: it is a refusal, not a retry.
                failedIds.delete(id);
                refusedIds.add(id);
                state.failed--;
                state.forbidden++;
            }
        } else {
            count(result.outcome);
            if (result.outcome === "forbidden") {
                refusedIds.add(id);
            } else if (result.outcome === "rate_limited") {
                // Four requests for one message and still throttled: it is not a transport loss and
                // not a refusal, so it needs its own bucket — otherwise the note would call it new.
                throttledIds.add(id);
                state.throttled++;
            } else if (result.outcome === "failed" && typeof result.status === "number" && result.status >= 400 && result.status < 500) {
                refusedIds.add(id);
            } else if (result.outcome === "failed") {
                // No status, status 0 (no HTTP answer) or a 5xx: worth exactly one more request.
                failedIds.add(id);
            }
        }
    };

    const progress = () =>
        `${state.deleted} deleted, ${state.gone} already gone, ${state.forbidden} refused, `
        + `${state.failed} failed${state.throttled > 0 ? `, ${state.throttled} throttled` : ""}`;

    try {
        for (let index = 0; index < queue.length; index++) {
            if (cancelRequested) break;

            await sleep(pacer.next());
            if (cancelRequested) break;

            const result = await attempt(queue[index].id);
            if (cancelRequested && result.outcome === "rate_limited") break;

            record(queue[index].id, result);
            guard(result);

            state.note = `${index + 1} / ${queue.length} — ${progress()}`;
            notify();
        }

        if (!cancelRequested && failedIds.size > 0) {
            // A failed request is not proof the message survived: the response can be lost. Retry
            // exactly those IDs once, so a flaky connection does not leave a tail behind.
            state.note = `${progress()}. Retrying ${failedIds.size} that failed…`;
            notify();

            for (const id of failedIds) {
                if (cancelRequested) break;
                await sleep(pacer.next());
                if (cancelRequested) break;

                const result = await attempt(id);
                record(id, result, true);
                guard(result);
                notify();
            }
        }

        if (!cancelRequested && settings.store.verifyAfterRun !== false) {
            // A run ends with counters, not with proof. Read the same range once more and say what is
            // really left; `cappedRun` separates "the cap stopped me" from "something went wrong".
            state.note = `${progress()}. Verifying — reading the range again…`;
            notify();

            const verification = new AbortController();
            scanAbort?.abort();
            scanAbort = verification;

            try {
                const remaining = await fetchWindow({
                    channelId,
                    filters: context.filters,
                    isCancelled: () => cancelRequested,
                    signal: verification.signal
                });

                if (cancelRequested) {
                    // Stop landed during the read, so the list is partial: a completeness claim
                    // built on it would be a guess.
                    state.phase = "stopped";
                    state.note = `Stopped — ${progress()}. Nothing was verified — the range was only partly read.`;
                } else {
                    // Count everything that matches, then separate the messages the run was allowed to
                    // delete from those it deliberately kept: a pinned message is not a failure, and
                    // saying "nothing left" while a pin remains would be a lie.
                    const allRemaining = buildDeleteQueue(remaining, context.filters, me, 0, false);
                    const stillThere = excludePinned ? allRemaining.filter(message => !message.pinned) : allRemaining;
                    const pinnedKept = allRemaining.length - stillThere.length;
                    const refusedLeft = stillThere.filter(message => refusedIds.has(message.id)).length;
                    const failedLeft = stillThere.filter(message => failedIds.has(message.id)).length;
                    const throttledLeft = stillThere.filter(message => throttledIds.has(message.id)).length;
                    const otherLeft = stillThere.length - refusedLeft - failedLeft - throttledLeft;
                    const withheldByCap = cappedRun ? Math.max(0, intended - queue.length) : 0;
                    const unexpectedLeft = Math.max(0, otherLeft - withheldByCap);
                    // Pins are counted from this read, not from the queue: a pin added after the
                    // preview was never seen by the setting, so the sentence must not claim it was.
                    const pinnedNote = pinnedKept > 0
                        ? ` ${pinnedKept} pinned left in the range (excludePinned is on).`
                        : "";

                    const reasons: string[] = [];
                    if (refusedLeft > 0) reasons.push(`${refusedLeft} answered with a 4xx (never retried)`);
                    if (throttledLeft > 0) reasons.push(`${throttledLeft} still rate-limited after their retries`);
                    if (failedLeft > 0) reasons.push(`${failedLeft} still failing after one retry`);
                    if (unexpectedLeft > 0) reasons.push(`${unexpectedLeft} arrived during the run or were never in the queue`);

                    state.phase = "done";
                    state.note = `Finished — ${progress()}. `
                        + (stillThere.length === 0
                            ? (pinnedKept > 0
                                ? `Verified: nothing left to delete — ${pinnedKept} pinned left in the range (excludePinned is on).`
                                : "Verified: nothing of yours matching that range is left.")
                            : `Verified: ${stillThere.length} of your matching messages still in the range — `
                                + (cappedRun
                                    ? `${queue.length} of ${intended} were queued; the cap stopped this run, preview again for the rest.`
                                        + (reasons.length > 0 ? ` Also: ${reasons.join("; ")}.` : "")
                                        + pinnedNote
                                    : `${reasons.join("; ")}.${pinnedNote}`)
                        );
                }
            } catch (error: any) {
                // The deletions are done; a failed verification is not a failed run. The exception is
                // a captcha: that is a signal to stop touching the account, so it keeps phase `error`.
                const captcha = String(error?.message ?? "").includes("captcha");
                state.phase = captcha ? "error" : cancelRequested ? "stopped" : "done";
                state.note = `${captcha ? "Run stopped by an error" : state.phase === "stopped" ? "Stopped" : "Finished"} — ${progress()}`
                    + ` (verification failed: ${String(error?.message ?? error)}). The counters describe the deletions, not the leftovers.`;
            } finally {
                if (scanAbort === verification) scanAbort = null;
            }
        } else {
            state.phase = cancelRequested ? "stopped" : "done";
            state.note = `${cancelRequested ? "Stopped" : "Finished"} — ${progress()}${cancelRequested ? "." : " (verification is off)."}`;
        }
    } catch (error: any) {
        // A throw must never leave the panel stuck in "deleting" with every control disabled.
        state.phase = "error";
        state.note = `Run stopped by an error: ${String(error?.message ?? error)}. ${progress()}.`;
    } finally {
        // A finished run must not be replayed: the queue is stale and most of it no longer exists.
        // Clearing it forces a fresh Preview before anything else can happen.
        scanned = null;
        armStamp = null;
        notify();
    }
}

async function startCore(): Promise<void> {
    let mode = String(settings.store.mode);

    // An unrecognised mode must not fall into the only branch that has no backup.
    if (mode !== "export" && mode !== "exportThenDelete" && mode !== "deleteOnly") mode = "exportThenDelete";

    if (mode === "export") {
        await exportCore();
        return;
    }

    let context: RunContext;

    try {
        context = currentContext(mode);
    } catch (error: any) {
        // A bad date or ID must not leave a confirmation armed for a run that cannot happen.
        gate.reset();
        armStamp = null;
        state.queued = 0;
        resetRun("error", String(error?.message ?? error));
        return;
    }

    // The preview must describe the same chat and the same range as the settings right now.
    if (scanned !== null
        && (scanned.target.channelId !== context.channelId || !filtersEqual(scanned.filters, context.filters))) {
        gate.reset();
        armStamp = null;
        scanned = null;
        notify();
        if (!(await scanCore(`Settings changed since the preview — reading ${context.label} again.`))) return;
    } else if (scanned === null && !(await scanCore())) {
        return;
    }

    if (scanned === null) return;

    // Same reason as in scanCore: an empty account id would silently produce an empty queue.
    const me = selfId();
    if (me === "") {
        gate.reset();
        armStamp = null;
        state.queued = 0;
        resetRun("error", "Discord has not finished loading your account — try again in a moment.");
        return;
    }

    const queue = buildDeleteQueue(scanned.messages, scanned.filters, me, context.limit, context.excludePinned);

    if (queue.length === 0) {
        gate.reset();
        armStamp = null;
        state.queued = 0;
        state.note = "Nothing to delete in this range.";
        notify();
        return;
    }

    // Two presses of Start: the first arms and shows the count, the second within the window
    // confirms. A double click counts as one press — see ArmGate.
    const decision = gate.press();

    if (decision === "soon") {
        // A press that lands inside the minimum gap is ignored on purpose, but silence looks like a
        // broken button. Say what happened.
        state.note = "Armed — press Start once more to confirm.";
        notify();
        return;
    }

    // A confirm is only valid for the exact run that was shown: same chat, same cap, same mode,
    // same range. Anything else re-arms instead of deleting something nobody saw.
    if (decision === "confirm" && sameRunContext(armStamp, context)) {
        await runDeletion(queue, context, me);
        return;
    }

    if (decision === "confirm") {
        gate.reset();
        gate.press();
        notify();
        // Re-arm below, with the refreshed context, so the next press confirms the new numbers.
    }

    const capNote = context.limit === 0 ? " — no cap, this is every matching message" : "";
    const changedNote = decision === "confirm" ? "Settings changed after you armed it — the count was refreshed. " : "";

    if (mode === "exportThenDelete") {
        // The backup for this exact run was already offered a moment ago, and the window has since
        // expired: re-arming costs nothing but two more save dialogs, so reuse the offer instead.
        if (lastOffer !== null && sameRunContext(lastOffer.stamp, context) && Date.now() - lastOffer.at < OFFER_REUSE_MS) {
            armStamp = lastOffer.stamp;
            state.queued = queue.length;
            state.note = `${changedNote}Backup offered (${state.total} messages in the whole range) — save both dialogs `
                + `if you have not, then press Start again to delete ${queue.length} of your messages${capNote}.`;
            notify();
            return;
        }

        // Backup first, confirm second: the two save dialogs need to be dealt with before
        // anything is deleted, otherwise "export then delete" is a promise nobody checked.
        if (!(await exportCore())) {
            gate.reset();
            armStamp = null;
            state.queued = 0;
            notify();
            return;
        }

        // The export can re-read the range (another chat or other filters), so the number shown next
        // to the backup must come from the scan the backup was made from, not from the earlier queue.
        if (scanned === null) {
            gate.reset();
            armStamp = null;
            state.queued = 0;
            notify();
            return;
        }

        const freshQueue = buildDeleteQueue(scanned.messages, scanned.filters, me, context.limit, context.excludePinned);

        if (freshQueue.length === 0) {
            gate.reset();
            armStamp = null;
            state.queued = 0;
            state.note = "Nothing to delete in this range.";
            notify();
            return;
        }

        armStamp = {
            ...context,
            channelId: scanned.target.channelId,
            label: scanned.target.label,
            filters: scanned.filters
        };
        state.queued = freshQueue.length;
        lastOffer = { stamp: armStamp, at: Date.now() };
        state.note = `${changedNote}Backup offered (${state.total} messages in the whole range). Save both dialogs, `
            + `then press Start again to delete ${freshQueue.length} of your messages${capNote}.`;
        notify();
        return;
    }

    armStamp = context;
    state.queued = queue.length;
    state.note = `${changedNote}About to delete ${queue.length} of your messages${capNote}. `
        + `Deletion is permanent. Press Start again to confirm.`;
    notify();
}


/** Start: one run at a time, and never on top of a scan or an export. */
async function start(): Promise<void> {
    // Refuse quietly: the running operation's progress is the more useful thing on screen.
    if (busy) return;

    busy = true;
    try {
        await startCore();
    } finally {
        busy = false;
    }
}

function stop() {
    cancelRequested = true;
    interruptSleep();

    if (state.phase === "scanning") {
        state.note = "Stopping — finishing the page in flight.";
    } else if (state.phase === "deleting") {
        state.note = "Stopping…";
    } else {
        return;
    }

    notify();
}

function Panel() {
    const [tick, setTick] = useState(0);

    useEffect(() => {
        const listener = () => setTick(value => value + 1);
        listeners.add(listener);
        return () => void listeners.delete(listener);
    }, []);

    // `isArmed` stays true until the next press, so an expired window would still draw a red
    // "Confirm delete" button that the press then re-arms. Draw Start instead once it expired.
    const armed = gate.isArmed && Date.now() < gate.armedUntil;

    useEffect(() => {
        if (!armed) return;
        const remainingMs = Math.max(0, gate.armedUntil - Date.now()) + 10;
        const timer = setTimeout(() => setTick(value => value + 1), remainingMs);
        return () => clearTimeout(timer);
    }, [armed, gate.armedUntil]);
    // Every long operation disables the controls: a second click during a scan would double the
    // requests, and a click during a deletion would start a second run on the same queue.
    const working = state.phase === "scanning" || state.phase === "exporting" || state.phase === "deleting";

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 8 }}>
            <div style={{ fontSize: 14, opacity: 0.85 }}>
                {state.note || "Set a target and the filters, then Preview. Nothing is deleted until you confirm twice."}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button size="small" onClick={() => void scan()} disabled={working}>
                    Preview
                </Button>
                <Button size="small" variant="secondary" onClick={() => void exportFiles()} disabled={working}>
                    Export JSON + TXT
                </Button>
                {String(settings.store.mode) !== "export" && (
                    <Button
                        size="small"
                        variant={armed ? "dangerPrimary" : "primary"}
                        onClick={() => void start()}
                        disabled={working}
                    >
                        {armed ? `Confirm delete (${state.queued})` : "Start"}
                    </Button>
                )}
                <Button size="small" variant="dangerSecondary" onClick={stop} disabled={state.phase !== "deleting" && state.phase !== "scanning"}>
                    Stop
                </Button>
            </div>
        </div>
    );
}

export default definePlugin({
    name: "MessagePurger",
    description: "Exports and deletes your own messages in a private chat or a server text channel, with date, text and attachment filters.",
    authors: [{ name: "HajiLight", id: 304361389659783168n }],
    tags: ["Utility", "Privacy", "Chat"],
    settings,

    // Exposed for debugging, and for anyone who wants to drive the same run from their own UI.
    // NOT named `start`: Vencord treats `start` (and `stop`) as lifecycle hooks and calls them when
    // the plugin loads or is enabled — which would begin a history read nobody asked for.
    scan,
    exportFiles,
    startRun: start,
    stopRun: stop,
    getState: () => ({ ...state }),

    stop() {
        cancelRequested = true;
        interruptSleep();
    }
});
