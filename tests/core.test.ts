import { describe, expect, it } from "vitest";

import {
    ArmGate,
    buildBackupSet,
    buildDeleteQueue,
    type ChatMessage,
    clampDelay,
    classifyDeleteStatus,
    CALL_MESSAGE_TYPE,
    countCallMessages,
    DEFAULT_ARM_GATE,
    DEFAULT_PACER,
    dateFromSnowflake,
    filtersEqual,
    formatJsonl,
    formatTxt,
    hasCaptchaKey,
    humanSize,
    isDeletable,
    matchesFilters,
    normaliseFilters,
    pageStep,
    safeFileName,
    Pacer,
    parseDateBound,
    parseRunCap,
    randomDelay,
    rangeLabel,
    sameRunContext,
    SNOWFLAKE_EPOCH,
    snowflakeFromDate
} from "../core";

const SELF = "111111111111111111";
const OTHER = "222222222222222222";
const fixed = (value: number) => () => value;

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
    return {
        id: "1",
        authorId: SELF,
        authorName: "HajiLight",
        timestamp: new Date("2024-03-05T12:00:00").getTime(),
        content: "hello",
        attachments: [],
        embedCount: 0,
        pinned: false,
        ...overrides
    };
}

const anyFilters = normaliseFilters({ attachmentMode: "any" });

describe("parseDateBound", () => {
    it("treats a bare date as the start or the end of that day", () => {
        const start = parseDateBound("2024-03-05", false)!;
        const end = parseDateBound("2024-03-05", true)!;

        expect(new Date(start)).toEqual(new Date("2024-03-05T00:00:00.000"));
        expect(new Date(end)).toEqual(new Date("2024-03-05T23:59:59.999"));
        expect(end - start).toBe(86_399_999);
    });

    it("accepts a date with a time and ignores endOfDay", () => {
        const value = parseDateBound("2024-03-05T18:30", false)!;

        expect(new Date(value)).toEqual(new Date("2024-03-05T18:30:00"));
        expect(parseDateBound("2024-03-05T18:30", true)).toBe(value);
    });

    it("returns undefined for a blank value", () => {
        expect(parseDateBound("", false)).toBeUndefined();
        expect(parseDateBound("   ", false)).toBeUndefined();
        expect(parseDateBound(undefined, false)).toBeUndefined();
    });

    it("rejects a malformed date instead of guessing", () => {
        expect(() => parseDateBound("05.03.2024", false)).toThrow(/Invalid date/);
        expect(() => parseDateBound("2024-13-45", false)).toThrow(/Invalid date/);
    });
});

describe("parseDateBound calendar validation", () => {
    it("accepts a real leap day", () => {
        expect(() => parseDateBound("2024-02-29", true)).not.toThrow();
    });

    it("rejects dates that look right and do not exist", () => {
        expect(() => parseDateBound("2024-02-30", true)).toThrow(/real calendar/);
        expect(() => parseDateBound("2023-02-29", true)).toThrow(/real calendar/);
        expect(() => parseDateBound("2024-04-31", true)).toThrow(/real calendar/);
    });

    it("rejects impossible times", () => {
        expect(() => parseDateBound("2024-05-01T25:00", false)).toThrow(/Hours/);
        expect(() => parseDateBound("2024-05-01T12:61", false)).toThrow(/minutes/);
        expect(() => parseDateBound("2024-05-01T12:30:99", false)).toThrow(/seconds/);
    });
});

describe("sameRunContext", () => {
    const base = {
        channelId: "1111",
        label: "chat",
        limit: 300,
        mode: "exportThenDelete",
        filters: normaliseFilters({ fromDate: "2024-01-01", toDate: "2024-12-31", contains: "x", attachmentMode: "any" })
    };

    it("is true only for the same chat, cap, mode and range", () => {
        expect(sameRunContext(base, { ...base })).toBe(true);
    });

    it("is false when any of them changed", () => {
        expect(sameRunContext(base, { ...base, channelId: "2222" })).toBe(false);
        expect(sameRunContext(base, { ...base, limit: 0 })).toBe(false);
        expect(sameRunContext(base, { ...base, mode: "deleteOnly" })).toBe(false);
        expect(sameRunContext(base, {
            ...base,
            filters: normaliseFilters({ fromDate: "2024-01-01", toDate: "2024-06-30" })
        })).toBe(false);
    });

    it("ignores the label, which is derived text rather than identity", () => {
        expect(sameRunContext(base, { ...base, label: "another name for the same chat" })).toBe(true);
    });

    it("is false when either side has no stamp at all", () => {
        expect(sameRunContext(null, base)).toBe(false);
        expect(sameRunContext(base, null)).toBe(false);
        expect(sameRunContext(null, null)).toBe(false);
    });

    it("compares excludePinned with a default of false", () => {
        expect(sameRunContext(base, { ...base, excludePinned: false })).toBe(true);
        expect(sameRunContext({ ...base, excludePinned: true }, { ...base, excludePinned: true })).toBe(true);
        expect(sameRunContext(base, { ...base, excludePinned: true })).toBe(false);
        expect(sameRunContext({ ...base, excludePinned: true }, { ...base, excludePinned: false })).toBe(false);
    });
});

describe("clampDelay", () => {
    it("keeps a sane value untouched", () => {
        expect(clampDelay(1400, 1400)).toBe(1400);
        expect(clampDelay("1400", 1400)).toBe(1400);
    });

    it("falls back when the value is not a number", () => {
        expect(clampDelay(Number.NaN, 1400)).toBe(1400);
        expect(clampDelay("abc", 1400)).toBe(1400);
        expect(clampDelay("", 1400)).toBe(1400);
        expect(clampDelay("   ", 1400)).toBe(1400);
        expect(clampDelay(undefined, 1400)).toBe(1400);
        expect(clampDelay(null, 1400)).toBe(1400);
    });

    it("never drops to a burst and never runs away", () => {
        // The floor is the lowest the slider offers (600 ms), which the jitter takes to 360 ms.
        expect(clampDelay(0, 1400)).toBe(600);
        expect(clampDelay(-500, 1400)).toBe(600);
        expect(clampDelay(60_000, 1400)).toBe(6000);
    });
});

describe("run cap", () => {
    it("keeps an explicit zero as no cap", () => {
        expect(parseRunCap(0)).toBe(0);
        expect(parseRunCap("0")).toBe(0);
    });

    it("falls back to the default when the value is missing or nonsense", () => {
        expect(parseRunCap(undefined)).toBe(300);
        expect(parseRunCap("")).toBe(300);
        expect(parseRunCap("abc")).toBe(300);
        expect(parseRunCap(-5)).toBe(300);
        expect(parseRunCap(Number.NaN)).toBe(300);
        expect(parseRunCap(Number.POSITIVE_INFINITY)).toBe(300);
    });

    it("treats a fraction as nonsense rather than as a zero cap", () => {
        expect(parseRunCap("0.5")).toBe(300);
        expect(parseRunCap(0.9)).toBe(300);
    });

    it("reads the select values", () => {
        expect(parseRunCap("300")).toBe(300);
        expect(parseRunCap("1000")).toBe(1000);
        expect(parseRunCap("3000")).toBe(3000);
    });
});

describe("filtersEqual", () => {
    it("is true for the same filters", () => {
        const one = normaliseFilters({ fromDate: "2024-01-01", toDate: "2024-12-31", contains: "x", attachmentMode: "any" });
        const two = normaliseFilters({ fromDate: "2024-01-01", toDate: "2024-12-31", contains: "x", attachmentMode: "any" });

        expect(filtersEqual(one, two)).toBe(true);
    });

    it("notices a changed bound, text or attachment mode", () => {
        const base = normaliseFilters({ fromDate: "2024-01-01", toDate: "2024-12-31", contains: "x", attachmentMode: "any" });

        expect(filtersEqual(base, normaliseFilters({ fromDate: "2024-02-01", toDate: "2024-12-31", contains: "x" }))).toBe(false);
        expect(filtersEqual(base, normaliseFilters({ fromDate: "2024-01-01", toDate: "2024-12-31", contains: "y" }))).toBe(false);
        expect(filtersEqual(base, normaliseFilters({ fromDate: "2024-01-01", toDate: "2024-12-31", contains: "x", attachmentMode: "only" }))).toBe(false);
    });
});

describe("snowflake guard", () => {
    it("refuses a date before Discord existed", () => {
        expect(() => snowflakeFromDate(Date.parse("2014-01-01T00:00:00Z"))).toThrow(/before 2015/);
        expect(() => snowflakeFromDate(Number.NaN)).toThrow(/not a number/);
    });

    it("accepts 2015-01-01, the epoch itself", () => {
        expect(snowflakeFromDate(SNOWFLAKE_EPOCH)).toBe("0");
    });
});

describe("normaliseFilters", () => {
    it("lower cases and trims the content filter", () => {
        expect(normaliseFilters({ contains: "  HeLLo  ", attachmentMode: "any" }).contains).toBe("hello");
    });

    it("leaves the content filter undefined when blank", () => {
        expect(normaliseFilters({ contains: "   ", attachmentMode: "any" }).contains).toBeUndefined();
    });

    it("falls back to \"any\" for an unknown attachment mode", () => {
        expect(normaliseFilters({ attachmentMode: "bogus" }).attachmentMode).toBe("any");
        expect(normaliseFilters({}).attachmentMode).toBe("any");
    });

    it("rejects a range where from is after to", () => {
        expect(() => normaliseFilters({ fromDate: "2024-04-01", toDate: "2024-03-01", attachmentMode: "any" }))
            .toThrow(/after/);
    });
});

describe("matchesFilters", () => {
    const filters = normaliseFilters({
        fromDate: "2024-03-05",
        toDate: "2024-03-05",
        contains: "hello",
        attachmentMode: "any"
    });

    it("accepts a message inside the range", () => {
        expect(matchesFilters(message(), filters)).toBe(true);
    });

    it("includes both ends of the date range", () => {
        const start = parseDateBound("2024-03-05", false)!;
        const end = parseDateBound("2024-03-05", true)!;

        expect(matchesFilters(message({ timestamp: start }), filters)).toBe(true);
        expect(matchesFilters(message({ timestamp: end }), filters)).toBe(true);
    });

    it("rejects a message whose timestamp could not be read", () => {
        // A NaN compares false against every bound, which used to let it through.
        expect(matchesFilters(message({ timestamp: Number.NaN }), filters)).toBe(false);
        expect(matchesFilters(message({ timestamp: Number.NaN }), anyFilters)).toBe(false);
    });

    it("rejects a message outside the range", () => {
        const before = parseDateBound("2024-03-05", false)! - 1;
        const after = parseDateBound("2024-03-05", true)! + 1;

        expect(matchesFilters(message({ timestamp: before }), filters)).toBe(false);
        expect(matchesFilters(message({ timestamp: after }), filters)).toBe(false);
    });

    it("matches content regardless of case and rejects non-matching content", () => {
        expect(matchesFilters(message({ content: "well HELLO there" }), filters)).toBe(true);
        expect(matchesFilters(message({ content: "completely different text" }), filters)).toBe(false);
    });

    it("matches on both sides of the conversation — a backup is the whole chat", () => {
        expect(matchesFilters(message({ authorId: OTHER }), filters)).toBe(true);
    });

    it("honours the attachment modes", () => {
        const withAttachment = message({
            attachments: [{ name: "a.png", url: "https://cdn/x", size: 100 }]
        });

        expect(matchesFilters(withAttachment, normaliseFilters({ attachmentMode: "only" }))).toBe(true);
        expect(matchesFilters(withAttachment, normaliseFilters({ attachmentMode: "without" }))).toBe(false);
        expect(matchesFilters(message(), normaliseFilters({ attachmentMode: "only" }))).toBe(false);
    });
});

describe("isDeletable", () => {
    it("is true for every message the user wrote herself", () => {
        expect(isDeletable(message(), SELF)).toBe(true);
        expect(isDeletable(message({ id: "2", content: "" }), SELF)).toBe(true);
    });

    it("is false for anyone else's message, which is the only rule Discord enforces with 403", () => {
        expect(isDeletable(message({ authorId: OTHER }), SELF)).toBe(false);
        expect(isDeletable(message({ authorId: "" }), SELF)).toBe(false);
    });

    it("deletes pinned messages by default and skips them when excludePinned is true", () => {
        expect(isDeletable(message({ pinned: true }), SELF)).toBe(true);
        expect(isDeletable(message({ pinned: true }), SELF, true)).toBe(false);
        expect(isDeletable(message({ pinned: true }), SELF, false)).toBe(true);
        expect(isDeletable(message({ pinned: false }), SELF, true)).toBe(true);
    });

    // A blanket type whitelist was wrong: pin notices (type 6) delete with 204. The exception is
    // measured, not assumed — call entries are type 3, empty content and a `call` object, and the
    // plugin does not queue them. Everything else is still attempted.
    it("skips only measured call entries, not every non-default message type", () => {
        const withType = (type: number) => ({ ...message(), type }) as unknown as ChatMessage;
        expect(isDeletable(withType(0), SELF)).toBe(true);
        expect(isDeletable(withType(CALL_MESSAGE_TYPE), SELF)).toBe(false);
        expect(isDeletable(withType(6), SELF)).toBe(true);
    });

    it("skips a call-shaped message even if the type mapping is missing", () => {
        const callShaped = message({ type: undefined, hasCall: true });
        expect(isDeletable(callShaped, SELF)).toBe(false);
    });

    it("counts own call entries in range, but never queues them", () => {
        const messages = [
            message({ id: "call", type: CALL_MESSAGE_TYPE, timestamp: 1000 }),
            message({ id: "other-call", authorId: OTHER, type: CALL_MESSAGE_TYPE, timestamp: 2000 }),
            message({ id: "normal", type: 0, timestamp: 3000 })
        ];

        expect(countCallMessages(messages, anyFilters, SELF)).toBe(1);
        expect(buildDeleteQueue(messages, anyFilters, SELF, 0).map(m => m.id)).toEqual(["normal"]);
    });
});

describe("buildBackupSet", () => {
    it("keeps every author, oldest first", () => {
        const backup = buildBackupSet(
            [
                message({ id: "c", timestamp: 3000 }),
                message({ id: "a", timestamp: 1000 }),
                message({ id: "other", authorId: OTHER, timestamp: 2000 })
            ],
            anyFilters
        );

        expect(backup.map(m => m.id)).toEqual(["a", "other", "c"]);
    });

    it("retains pinned and other-author messages in backups", () => {
        const backup = buildBackupSet(
            [
                message({ id: "mine", timestamp: 1000 }),
                message({ id: "theirs", authorId: OTHER, timestamp: 2000 }),
                message({ id: "pin", pinned: true, timestamp: 3000 })
            ],
            anyFilters
        );

        expect(backup.map(m => m.id)).toEqual(["mine", "theirs", "pin"]);
    });
});

describe("buildDeleteQueue", () => {
    it("keeps only the user's own messages, oldest first, capped", () => {
        const queue = buildDeleteQueue(
            [
                message({ id: "a", timestamp: 1000 }),
                message({ id: "other", authorId: OTHER, timestamp: 1500 }),
                message({ id: "b", timestamp: 2000 }),
                message({ id: "c", timestamp: 3000 })
            ],
            anyFilters,
            SELF,
            2
        );

        expect(queue.map(m => m.id)).toEqual(["a", "b"]);
    });

    it("does not let a contradictory duplicate override a call marker in either order", () => {
        expect(buildDeleteQueue([
            message({ id: "same", type: CALL_MESSAGE_TYPE, timestamp: 1000 }),
            message({ id: "same", type: 0, timestamp: 2000 })
        ], anyFilters, SELF, 0)).toEqual([]);
        expect(buildDeleteQueue([
            message({ id: "same", type: 0, timestamp: 2000 }),
            message({ id: "same", type: CALL_MESSAGE_TYPE, timestamp: 1000 })
        ], anyFilters, SELF, 0)).toEqual([]);
    });

    it("treats a zero limit as no limit", () => {
        const queue = buildDeleteQueue([message({ id: "a" }), message({ id: "b" })], anyFilters, SELF, 0);

        expect(queue).toHaveLength(2);
    });

    it("queues every message of yours and respects excludePinned", () => {
        const messages = [
            message({ id: "def", timestamp: 1000 }),
            message({ id: "reply", timestamp: 4000 }),
            message({ id: "pin", pinned: true, timestamp: 6000 }),
            message({ id: "theirs", authorId: OTHER, timestamp: 7000 })
        ];

        expect(buildDeleteQueue(messages, anyFilters, SELF, 0).map(m => m.id)).toEqual(["def", "reply", "pin"]);
        expect(buildDeleteQueue(messages, anyFilters, SELF, 0, true).map(m => m.id)).toEqual(["def", "reply"]);
        expect(buildDeleteQueue(messages, anyFilters, SELF, 0, false).map(m => m.id)).toEqual(["def", "reply", "pin"]);
    });
});

describe("randomDelay", () => {
    it("stays inside the range, both ends included", () => {
        expect(randomDelay(600, 1200, () => 0)).toBe(600);
        expect(randomDelay(600, 1200, () => 1)).toBe(1200);
        expect(randomDelay(600, 1200, () => 0.5)).toBe(900);
    });

    it("collapses to the bound when the range is empty or inverted", () => {
        expect(randomDelay(500, 500, () => 0.7)).toBe(500);
        expect(randomDelay(800, 400, () => 0.7)).toBe(800);
        expect(randomDelay(-10, 10, () => 0)).toBe(0);
    });
});

describe("classifyDeleteStatus", () => {
    it("reads 204 and 200 as deleted", () => {
        expect(classifyDeleteStatus(204).outcome).toBe("deleted");
        expect(classifyDeleteStatus(200).outcome).toBe("deleted");
    });

    it("reads 404 as already gone", () => {
        expect(classifyDeleteStatus(404).outcome).toBe("gone");
    });

    it("reads 403 as refused", () => {
        expect(classifyDeleteStatus(403).outcome).toBe("forbidden");
    });

    it("reads 429 as rate limited, with default retry delay if omitted", () => {
        const result = classifyDeleteStatus(429);
        expect(result.outcome).toBe("rate_limited");
        expect(result.retryAfterMs).toBe(1000);
    });

    it("reads 429 as rate limited, with the server's retry delay in milliseconds", () => {
        const result = classifyDeleteStatus(429, 2.5);

        expect(result.outcome).toBe("rate_limited");
        expect(result.retryAfterMs).toBe(2500);
    });

    it("reads anything else as failed", () => {
        expect(classifyDeleteStatus(500).outcome).toBe("failed");
        expect(classifyDeleteStatus(500, 3).retryAfterMs).toBe(3000);
        expect(classifyDeleteStatus(undefined).outcome).toBe("failed");
        expect(classifyDeleteStatus(401)).toEqual({ outcome: "failed", status: 401, retryAfterMs: undefined });
        expect(classifyDeleteStatus(400)).toEqual({ outcome: "failed", status: 400, retryAfterMs: undefined });
    });

    it("reads 400 with captcha_key as captcha and ignores captcha_key on non-400 statuses", () => {
        expect(classifyDeleteStatus(400, undefined, { captcha_key: ["captcha-required"] })).toEqual({
            outcome: "captcha",
            status: 400
        });
        expect(classifyDeleteStatus(400, undefined, { captcha_key: "token" })).toEqual({
            outcome: "captcha",
            status: 400
        });
        expect(classifyDeleteStatus(400, undefined, { captcha_key: [] }).outcome).toBe("failed");
        expect(classifyDeleteStatus(500, undefined, { captcha_key: ["x"] }).outcome).toBe("failed");
    });
});

describe("hasCaptchaKey", () => {
    it("detects non-empty captcha_key arrays or truthy values", () => {
        expect(hasCaptchaKey({ captcha_key: ["captcha-required"] })).toBe(true);
        expect(hasCaptchaKey({ captcha_key: "token" })).toBe(true);
    });

    it("returns false for absent, empty, null, or non-object bodies", () => {
        expect(hasCaptchaKey(undefined)).toBe(false);
        expect(hasCaptchaKey(null)).toBe(false);
        expect(hasCaptchaKey("str")).toBe(false);
        expect(hasCaptchaKey({})).toBe(false);
        expect(hasCaptchaKey({ captcha_key: [] })).toBe(false);
        expect(hasCaptchaKey({ captcha_key: null })).toBe(false);
        expect(hasCaptchaKey({ captcha_key: "" })).toBe(false);
    });
});

describe("duplicates", () => {
    it("keeps one entry per id in a backup", () => {
        const backup = buildBackupSet([message({ id: "a" }), message({ id: "a" }), message({ id: "b" })], anyFilters);

        expect(backup.map(m => m.id)).toEqual(["a", "b"]);
    });

    it("keeps one entry per id in a delete queue", () => {
        const queue = buildDeleteQueue([message({ id: "a" }), message({ id: "a" })], anyFilters, SELF, 0);

        expect(queue).toHaveLength(1);
    });
});

describe("ArmGate", () => {
    const gate = () => new ArmGate({ confirmWindowMs: 10_000, minimumGapMs: 1500 });

    it("arms on the first press and deletes nothing yet", () => {
        expect(gate().press(1000)).toBe("arm");
    });

    it("ignores a second press that arrives too fast — a double click is one intention", () => {
        const armGate = gate();
        armGate.press(1000);

        expect(armGate.press(1100)).toBe("soon");
        expect(armGate.isArmed).toBe(true);
    });

    it("confirms when the second press comes after the minimum gap", () => {
        const armGate = gate();
        armGate.press(1000);

        expect(armGate.press(2600)).toBe("confirm");
        expect(armGate.isArmed).toBe(false);
    });

    it("re-arms instead of confirming once the window has passed", () => {
        const armGate = gate();
        armGate.press(1000);

        expect(armGate.press(1000 + 10_000 + 1)).toBe("arm");
        expect(armGate.isArmed).toBe(true);
    });

    it("reports the armed deadline and can be reset", () => {
        const armGate = gate();
        armGate.press(1000);

        expect(armGate.armedUntil).toBe(11_000);
        armGate.reset();
        expect(armGate.isArmed).toBe(false);
        expect(armGate.armedUntil).toBe(0);
    });
});

describe("snowflakes", () => {
    it("round trips a timestamp", () => {
        const timestamp = Date.UTC(2024, 5, 15, 10, 30);

        expect(dateFromSnowflake(snowflakeFromDate(timestamp))).toBe(timestamp);
    });

    it("produces the documented shape for a known instant", () => {
        const cursor = snowflakeFromDate(Date.UTC(2025, 0, 1));

        expect(cursor).toBe("1323802873036800000");
        expect(dateFromSnowflake(cursor)).toBe(Date.UTC(2025, 0, 1));
    });
});

describe("formatJsonl", () => {
    it("writes one JSON object per message with a trailing newline", () => {
        const text = formatJsonl([message({ id: "a" }), message({ id: "b" })]);
        const lines = text.trimEnd().split("\n");

        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0]).id).toBe("a");
        expect(text.endsWith("\n")).toBe(true);
    });

    it("keeps newlines inside the content escaped, not split across lines", () => {
        const text = formatJsonl([message({ content: "line one\nline two" })]);

        expect(text.trimEnd().split("\n")).toHaveLength(1);
        expect(JSON.parse(text.trimEnd()).content).toBe("line one\nline two");
    });

    it("records attachments with their expiry-bearing url", () => {
        const text = formatJsonl([message({
            attachments: [{ name: "photo.png", url: "https://cdn/x?ex=1", size: 2048, contentType: "image/png" }]
        })]);

        expect(JSON.parse(text.trimEnd()).attachments).toEqual([
            { name: "photo.png", size: 2048, contentType: "image/png", url: "https://cdn/x?ex=1" }
        ]);
    });

    it("records editedTimestamp as ISO string when present", () => {
        const text = formatJsonl([message({
            editedTimestamp: new Date("2024-03-05T12:05:00Z").getTime()
        })]);
        expect(JSON.parse(text.trimEnd()).editedAt).toBe("2024-03-05T12:05:00.000Z");
    });

    it("is empty for an empty chat", () => {
        expect(formatJsonl([])).toBe("");
    });
});

describe("formatTxt", () => {
    const stamp = () => "2024-03-05 12:00";

    it("writes header, content and attachment lines", () => {
        const text = formatTxt([
            message({ content: "hello there", attachments: [{ name: "a.pdf", url: "https://cdn/a", size: 1536 }] })
        ], stamp);

        expect(text).toContain("[2024-03-05 12:00] HajiLight");
        expect(text).toContain("hello there");
        expect(text).toContain("[file] a.pdf (1.5 kB)");
    });

    it("omits body when content is empty", () => {
        const text = formatTxt([
            message({ content: "", attachments: [{ name: "photo.png", url: "https://cdn/p", size: 100 }] })
        ], stamp);
        expect(text).toBe("[2024-03-05 12:00] HajiLight\n    [file] photo.png (100 B)\n");
    });

    it("returns empty string when messages array is empty", () => {
        expect(formatTxt([], stamp)).toBe("");
    });

    it("marks edits and replies", () => {
        const text = formatTxt([
            message({ editedTimestamp: 1000, replyToAuthor: "Someone" })
        ], stamp);

        expect(text).toContain("↪ Someone");
        expect(text).toContain("(edited)");
    });

    it("separates messages with a blank line", () => {
        const text = formatTxt([message({ id: "a" }), message({ id: "b" })], stamp);

        expect(text.trimEnd().split("\n\n")).toHaveLength(2);
    });
});

describe("helpers", () => {
    it("humanSize steps through B, kB and MB", () => {
        expect(humanSize(10)).toBe("10 B");
        expect(humanSize(1536)).toBe("1.5 kB");
        expect(humanSize(3 * 1024 * 1024)).toBe("3.0 MB");
    });

    it("rangeLabel names the range or says all-time", () => {
        expect(rangeLabel(anyFilters)).toBe("all-time");

        const bounded = normaliseFilters({ fromDate: "2024-01-01", toDate: "2024-12-31", attachmentMode: "any" });
        const label = rangeLabel(bounded);

        expect(label).toContain("_");
        expect(label.split("_")).toHaveLength(2);

        const onlyFrom = normaliseFilters({ fromDate: "2024-01-01", attachmentMode: "any" });
        expect(rangeLabel(onlyFrom)).toBe("2024-01-01_end");

        const onlyTo = normaliseFilters({ toDate: "2024-12-31", attachmentMode: "any" });
        expect(rangeLabel(onlyTo)).toBe("start_2024-12-31");
    });
});

describe("Pacer", () => {
    it("never lowers a base that is already above the ceiling", () => {
        // Only reachable through a hand-edited settings file: the slider stops at 4000.
        const pacer = new Pacer({ ...DEFAULT_PACER, baseDelayMs: 6000 }, fixed(0));

        expect(pacer.currentBase).toBe(6000);
        pacer.onRateLimited(1000, fixed(0));
        expect(pacer.currentBase).toBe(6000);
    });

    it("keeps the delay inside the jitter band", () => {
        const pacer = new Pacer(DEFAULT_PACER, fixed(0));

        expect(pacer.next(fixed(0))).toBe(Math.round(DEFAULT_PACER.baseDelayMs * 0.6));
        expect(pacer.next(fixed(1))).toBe(Math.round(DEFAULT_PACER.baseDelayMs * 1.4));
    });

    it("takes a long pause after the chosen number of deletions", () => {
        const pacer = new Pacer(DEFAULT_PACER, fixed(0));

        for (let i = 0; i < DEFAULT_PACER.pauseEveryMin; i++) pacer.next(fixed(0));

        const pause = pacer.next(fixed(0));
        expect(pause).toBeGreaterThanOrEqual(DEFAULT_PACER.pauseMinMs);
        expect(pause).toBeLessThanOrEqual(DEFAULT_PACER.pauseMaxMs);
    });

    it("slows down after a rate limit and stops at the ceiling", () => {
        const pacer = new Pacer(DEFAULT_PACER, fixed(0));
        const before = pacer.currentBase;

        for (let i = 0; i < 20; i++) pacer.onRateLimited(1000, fixed(0));

        expect(pacer.currentBase).toBeGreaterThan(before);
        expect(pacer.currentBase).toBeLessThanOrEqual(DEFAULT_PACER.ceilingMs);
    });

    it("waits past the retry_after it was given", () => {
        const pacer = new Pacer(DEFAULT_PACER, fixed(0));

        expect(pacer.onRateLimited(5000, fixed(0))).toBeGreaterThan(5000);
    });
});

describe("pageStep — history paging", () => {
    const page = (...ids: string[]) => ids.map(id => ({ id }));

    it("ends on an empty page", () => {
        expect(pageStep([], "100", true)).toEqual({ kind: "end" });
    });

    it("ends when the page is the cursor itself, already read", () => {
        expect(pageStep(page("100"), "100", true)).toEqual({ kind: "end" });
    });

    it("does not treat a one-message page as the end when the cursor was synthetic", () => {
        // A cursor derived from `toDate` need not be the ID of any message, so a real message can
        // sit exactly on it. Ending there would cut the backup to a single page.
        expect(pageStep(page("100"), "100", false)).toEqual({ kind: "continue", cursor: "100" });
    });

    it("continues while the cursor moves strictly backwards", () => {
        expect(pageStep(page("300", "200", "100"), "400", true)).toEqual({ kind: "continue", cursor: "100" });
    });

    it("continues when a page holds one *new* message", () => {
        expect(pageStep(page("90"), "100", true)).toEqual({ kind: "continue", cursor: "90" });
    });

    it("reports no progress when the same cursor comes back with several messages", () => {
        expect(pageStep(page("200", "100"), "100", true).kind).toBe("error");
    });

    it("reports no progress when the cursor grows", () => {
        expect(pageStep(page("500", "400"), "100", true).kind).toBe("error");
    });

    it("starts a scan without a cursor at all", () => {
        expect(pageStep(page("100"), undefined, false)).toEqual({ kind: "continue", cursor: "100" });
    });

    it("keeps the production confirmation window at a full minute", () => {
        expect(DEFAULT_ARM_GATE.confirmWindowMs).toBe(60_000);
        expect(DEFAULT_ARM_GATE.minimumGapMs).toBe(1_500);
        expect(new ArmGate().isArmed).toBe(false);
    });
});

describe("safeFileName", () => {
    it("keeps letters of any script, so a Polish channel keeps its name", () => {
        expect(safeFileName("ogólny")).toBe("ogólny");
        expect(safeFileName("日本語")).toBe("日本語");
    });

    it("removes what a file system refuses", () => {
        const name = safeFileName('a/b:c*d?e"f<g>h|i\j');
        expect(name).not.toMatch(/[<>:"/\|?*]/);
    });

    it("falls back to chat when there is nothing usable", () => {
        expect(safeFileName("")).toBe("chat");
        expect(safeFileName("///").startsWith("_")).toBe(true);
    });

    it("truncates by code points and never leaves half a character", () => {
        const label = `${"x".repeat(39)}𝐀${"y".repeat(10)}`;
        const name = safeFileName(label);
        const points = Array.from(name.replace(/-\w{6}$/, ""));

        expect(points.length).toBeLessThanOrEqual(36);
        expect(/[\uD800-\uDBFF]$/.test(name)).toBe(false);
        expect(/[\uDC00-\uDFFF]/.test(name)).toBe(false);
    });

    it("separates two chats that share a long prefix", () => {
        const base = "a".repeat(41);
        expect(safeFileName(`${base}One`)).not.toBe(safeFileName(`${base}Two`));
    });

    it("is deterministic for the same label", () => {
        const label = `${"z".repeat(60)}`;
        expect(safeFileName(label)).toBe(safeFileName(label));
        expect(safeFileName(label).length).toBeLessThanOrEqual(43);
    });
});
