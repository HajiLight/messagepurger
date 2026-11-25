import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockChannelStore, mockUserStore, mockRestAPI } = vi.hoisted(() => ({
    mockChannelStore: {
        getChannel: vi.fn(),
        getDMFromUserId: vi.fn()
    },
    mockUserStore: {
        getUser: vi.fn(),
        getCurrentUser: vi.fn()
    },
    mockRestAPI: {
        get: vi.fn(),
        del: vi.fn()
    }
}));

vi.mock("@webpack/common", () => ({
    ChannelStore: mockChannelStore,
    UserStore: mockUserStore,
    RestAPI: mockRestAPI
}));

import {
    deleteMessage,
    fetchWindow,
    resolveTarget,
    selfId
} from "../discord";
import { normaliseFilters } from "../core";

describe("discord adapter", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe("resolveTarget", () => {
        it("rejects non-digit or invalid length target IDs", () => {
            expect(() => resolveTarget("abc")).toThrow(/Enter a Discord ID/);
            expect(() => resolveTarget("12345")).toThrow(/Enter a Discord ID/);
            expect(() => resolveTarget("12345678901234567890123")).toThrow(/Enter a Discord ID/);
        });

        it("resolves a guild channel by channel ID", () => {
            mockChannelStore.getChannel.mockReturnValue({
                id: "123456789012345678",
                type: 0,
                name: "general"
            });

            const target = resolveTarget("123456789012345678");
            expect(target).toEqual({
                channelId: "123456789012345678",
                kind: "guild",
                label: "general"
            });
        });

        it("resolves a guild announcement channel (type 5)", () => {
            mockChannelStore.getChannel.mockReturnValue({
                id: "123456789012345678",
                type: 5,
                name: "announcements"
            });

            const target = resolveTarget("123456789012345678");
            expect(target.kind).toBe("guild");
            expect(target.label).toBe("announcements");
        });

        it("resolves a group DM (type 3)", () => {
            mockChannelStore.getChannel.mockReturnValue({
                id: "123456789012345678",
                type: 3,
                name: "The Group"
            });

            const target = resolveTarget("123456789012345678");
            expect(target.kind).toBe("group");
            expect(target.label).toBe("The Group");
        });

        it("resolves channel with fallback kind for other channel types", () => {
            mockChannelStore.getChannel.mockReturnValue({
                id: "123456789012345678",
                type: 2 // voice channel
            });

            const target = resolveTarget("123456789012345678");
            expect(target.kind).toBe("other");
            expect(target.label).toBe("123456789012345678");
        });

        it("resolves a DM channel by channel ID with recipient globalName", () => {
            mockChannelStore.getChannel.mockReturnValue({
                id: "123456789012345678",
                type: 1,
                recipients: ["987654321098765432"]
            });
            mockUserStore.getUser.mockReturnValue({
                globalName: "Alice Wonderland",
                username: "alice"
            });

            const target = resolveTarget("123456789012345678");
            expect(target).toEqual({
                channelId: "123456789012345678",
                kind: "dm",
                label: "Alice Wonderland"
            });
        });

        it("resolves a DM channel with recipient username when globalName is absent", () => {
            mockChannelStore.getChannel.mockReturnValue({
                id: "123456789012345678",
                type: 1,
                recipients: ["987654321098765432"]
            });
            mockUserStore.getUser.mockReturnValue({
                username: "alice_only"
            });

            const target = resolveTarget("123456789012345678");
            expect(target.label).toBe("alice_only");
        });

        it("resolves a DM by user ID if channel is not directly found", () => {
            mockChannelStore.getChannel.mockReturnValue(undefined);
            mockChannelStore.getDMFromUserId.mockReturnValue("111222333444555666");
            mockUserStore.getUser.mockReturnValue({
                globalName: "Bob The Builder"
            });

            const target = resolveTarget("987654321098765432");
            expect(target).toEqual({
                channelId: "111222333444555666",
                kind: "dm",
                label: "Bob The Builder"
            });
        });

        it("resolves a DM channel with empty recipients list", () => {
            mockChannelStore.getChannel.mockReturnValue({
                id: "123456789012345678",
                type: 1,
                name: "dm-fallback",
                recipients: []
            });

            const target = resolveTarget("123456789012345678");
            expect(target.label).toBe("dm-fallback");
        });

        it("resolves a DM channel with fallback label when recipient user has no names", () => {
            mockChannelStore.getChannel.mockReturnValue({
                id: "123456789012345678",
                type: 1,
                recipients: ["987654321098765432"]
            });
            mockUserStore.getUser.mockReturnValue({});

            const target = resolveTarget("123456789012345678");
            expect(target.label).toBe("123456789012345678");
        });

        it("resolves a channel with no name falling back to id", () => {
            mockChannelStore.getChannel.mockReturnValue({
                id: "123456789012345678",
                type: 0,
                name: null
            });

            const target = resolveTarget("123456789012345678");
            expect(target.label).toBe("123456789012345678");
        });

        it("resolves a DM by user ID falling back to username when globalName is absent", () => {
            mockChannelStore.getChannel.mockReturnValue(undefined);
            mockChannelStore.getDMFromUserId.mockReturnValue("111222333444555666");
            mockUserStore.getUser.mockReturnValue({
                username: "bob_only"
            });

            const target = resolveTarget("987654321098765432");
            expect(target.label).toBe("bob_only");
        });

        it("resolves a DM by user ID falling back to dmChannelId when user is missing", () => {
            mockChannelStore.getChannel.mockReturnValue(undefined);
            mockChannelStore.getDMFromUserId.mockReturnValue("111222333444555666");
            mockUserStore.getUser.mockReturnValue(undefined);

            const target = resolveTarget("987654321098765432");
            expect(target.label).toBe("111222333444555666");
        });

        it("throws when neither channel nor DM is found", () => {
            mockChannelStore.getChannel.mockReturnValue(undefined);
            mockChannelStore.getDMFromUserId.mockReturnValue(undefined);

            expect(() => resolveTarget("987654321098765432")).toThrow(/No channel and no private chat found/);
        });
    });

    describe("selfId", () => {
        it("returns the current user id as string", () => {
            mockUserStore.getCurrentUser.mockReturnValue({ id: "123456" });
            expect(selfId()).toBe("123456");
        });

        it("returns empty string when current user is missing", () => {
            mockUserStore.getCurrentUser.mockReturnValue(undefined);
            expect(selfId()).toBe("");
        });
    });

    describe("deleteMessage", () => {
        it("returns success outcome on 204 or 200", async () => {
            mockRestAPI.del.mockResolvedValue({ status: 204 });
            const res = await deleteMessage("111", "222");
            expect(res.outcome).toBe("deleted");
            expect(res.status).toBe(204);
        });

        it("returns failed when response status is undefined", async () => {
            mockRestAPI.del.mockResolvedValue({});
            const res = await deleteMessage("111", "222");
            expect(res.outcome).toBe("failed");
        });

        it("handles 404 gone", async () => {
            mockRestAPI.del.mockRejectedValue({ status: 404 });
            const res = await deleteMessage("111", "222");
            expect(res.outcome).toBe("gone");
        });

        it("handles 403 forbidden", async () => {
            mockRestAPI.del.mockRejectedValue({ status: 403 });
            const res = await deleteMessage("111", "222");
            expect(res.outcome).toBe("forbidden");
        });

        it("handles 429 rate_limited with retryAfter", async () => {
            mockRestAPI.del.mockRejectedValue({ status: 429, retryAfter: 1.5 });
            const res = await deleteMessage("111", "222");
            expect(res.outcome).toBe("rate_limited");
            expect(res.retryAfterMs).toBe(1500);
        });

        it("handles network error without status", async () => {
            mockRestAPI.del.mockRejectedValue(new Error("Network failed"));
            const res = await deleteMessage("111", "222");
            expect(res.outcome).toBe("failed");
        });

        it("detects HTTP 400 captcha_key in response body or error text", async () => {
            mockRestAPI.del.mockRejectedValueOnce({
                status: 400,
                body: { captcha_key: ["captcha-required"] }
            });
            expect(await deleteMessage("111", "222")).toEqual({ outcome: "captcha", status: 400 });

            mockRestAPI.del.mockResolvedValueOnce({
                status: 400,
                body: {},
                text: JSON.stringify({ captcha_key: ["need-captcha"] })
            });
            expect(await deleteMessage("111", "222")).toEqual({ outcome: "captcha", status: 400 });

            mockRestAPI.del.mockRejectedValueOnce({
                status: 400,
                body: JSON.stringify({ captcha_key: ["string-body-captcha"] })
            });
            expect(await deleteMessage("111", "222")).toEqual({ outcome: "captcha", status: 400 });

            mockRestAPI.del.mockRejectedValueOnce({
                status: 400,
                body: {},
                text: "not-valid-json"
            });
            expect(await deleteMessage("111", "222")).toEqual({ outcome: "failed", status: 400, retryAfterMs: undefined });
        });

        it("extracts retry_after from body or JSON text on HTTP 429 when retryAfter is absent", async () => {
            mockRestAPI.del.mockRejectedValueOnce({
                status: 429,
                body: { retry_after: 2.5 }
            });
            expect(await deleteMessage("111", "222")).toEqual({
                outcome: "rate_limited",
                status: 429,
                retryAfterMs: 2500
            });

            mockRestAPI.del.mockResolvedValueOnce({
                status: 429,
                body: {},
                text: JSON.stringify({ retry_after: 1.25 })
            });
            expect(await deleteMessage("111", "222")).toEqual({
                outcome: "rate_limited",
                status: 429,
                retryAfterMs: 1250
            });
        });

        it("maps HTTP 401 and non-captcha HTTP 400 to failed with status", async () => {
            mockRestAPI.del.mockRejectedValueOnce({ status: 401 });
            expect(await deleteMessage("111", "222")).toEqual({ outcome: "failed", status: 401, retryAfterMs: undefined });

            mockRestAPI.del.mockRejectedValueOnce({ status: 400, body: { code: 50021 } });
            expect(await deleteMessage("111", "222")).toEqual({ outcome: "failed", status: 400, retryAfterMs: undefined });
        });
    });

    describe("fetchWindow", () => {
        const filters = normaliseFilters({ attachmentMode: "any" });

        it("fetches pages and maps message fields properly", async () => {
            mockRestAPI.get.mockResolvedValueOnce({
                body: [
                    {
                        id: "100000000000000002",
                        author: { id: "123", username: "alice", globalName: "Alice" },
                        timestamp: "2024-03-05T12:00:00Z",
                        edited_timestamp: "2024-03-05T12:05:00Z",
                        content: "hello world",
                        attachments: [{ filename: "doc.pdf", url: "https://cdn/doc.pdf", size: 500, content_type: "application/pdf" }],
                        embeds: [{}],
                        referenced_message: { author: { globalName: "Bob" } }
                    },
                    {
                        id: "100000000000000001",
                        author: { username: "charlie" },
                        timestamp: "2024-03-05T11:00:00Z",
                        content: null,
                        attachments: null,
                        embeds: null
                    }
                ]
            }).mockResolvedValueOnce({
                body: []
            });

            const messages = await fetchWindow({
                channelId: "chan1",
                filters,
                pageDelayMinMs: 0,
                pageDelayMaxMs: 0
            });

            expect(messages).toHaveLength(2);
            expect(messages[0].authorName).toBe("Alice");
            expect(messages[0].replyToAuthor).toBe("Bob");
            expect(messages[0].attachments[0].name).toBe("doc.pdf");
            expect(messages[0].embedCount).toBe(1);
            expect(messages[1].authorName).toBe("charlie");
            expect(messages[1].content).toBe("");
            expect(messages[1].attachments).toEqual([]);
        });

        it("stops early when isCancelled returns true", async () => {
            let cancelled = false;
            mockRestAPI.get.mockImplementation(async () => {
                cancelled = true;
                return {
                    body: [
                        { id: "100000000000000002", timestamp: "2024-03-05T12:00:00Z" }
                    ]
                };
            });

            const messages = await fetchWindow({
                channelId: "chan1",
                filters,
                isCancelled: () => cancelled,
                pageDelayMinMs: 0,
                pageDelayMaxMs: 0
            });

            expect(messages).toHaveLength(1);
        });

        it("stops when maxMessages limit is reached", async () => {
            mockRestAPI.get.mockResolvedValueOnce({
                body: [
                    { id: "100000000000000002", timestamp: "2024-03-05T12:00:00Z" },
                    { id: "100000000000000001", timestamp: "2024-03-05T11:00:00Z" }
                ]
            });

            const messages = await fetchWindow({
                channelId: "chan1",
                filters,
                maxMessages: 1,
                pageDelayMinMs: 0,
                pageDelayMaxMs: 0
            });

            expect(messages).toHaveLength(2);
        });

        it("throws when response body is not an array", async () => {
            mockRestAPI.get.mockResolvedValueOnce({
                body: { message: "Internal Error" }
            });

            await expect(fetchWindow({
                channelId: "chan1",
                filters,
                pageDelayMinMs: 0,
                pageDelayMaxMs: 0
            })).rejects.toThrow(/Unexpected history response/);
        });

        it("stops when oldest message is before filters.from", async () => {
            // Snowflake epoch 1420070400000
            // 2024-01-01 is timestamp 1704067200000
            const filterWithFrom = normaliseFilters({ fromDate: "2024-02-01", attachmentMode: "any" });

            mockRestAPI.get.mockResolvedValueOnce({
                body: [
                    { id: "100000000000000002", timestamp: "2024-02-05T12:00:00Z" },
                    // Snowflake for an older timestamp (e.g. before Feb 2024)
                    { id: "1157819875440787456", timestamp: "2023-12-01T12:00:00Z" }
                ]
            });

            const messages = await fetchWindow({
                channelId: "chan1",
                filters: filterWithFrom,
                pageDelayMinMs: 0,
                pageDelayMaxMs: 0
            });

            expect(messages).toHaveLength(2);
            expect(mockRestAPI.get).toHaveBeenCalledTimes(1);
        });

        it("reports progress via onProgress callback", async () => {
            const onProgress = vi.fn();
            mockRestAPI.get.mockResolvedValueOnce({
                body: [
                    { id: "1157819875440787456", timestamp: "2023-12-01T12:00:00Z" }
                ]
            }).mockResolvedValueOnce({
                body: []
            });

            await fetchWindow({
                channelId: "chan1",
                filters,
                onProgress,
                pageDelayMinMs: 0,
                pageDelayMaxMs: 0
            });

            expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
                pages: 1,
                messages: 1
            }));
        });

        it("applies synthetic cursor from filters.to and sleeps between pages", async () => {
            vi.useFakeTimers();
            const filterWithTo = normaliseFilters({ toDate: "2024-03-05", attachmentMode: "any" });

            mockRestAPI.get.mockResolvedValueOnce({
                body: [
                    { id: "1214567890123456789", timestamp: "2024-03-05T12:00:00Z" },
                    { id: "1214567890123456780", timestamp: "2024-03-05T11:00:00Z" }
                ]
            }).mockResolvedValueOnce({
                body: []
            });

            const fetchPromise = fetchWindow({
                channelId: "chan1",
                filters: filterWithTo,
                pageDelayMinMs: 10,
                pageDelayMaxMs: 20
            });

            await vi.runAllTimersAsync();
            const messages = await fetchPromise;
            expect(messages).toHaveLength(2);
            expect(mockRestAPI.get).toHaveBeenCalledWith({
                url: expect.stringContaining("&before=")
            });
            vi.useRealTimers();
        });

        it("throws when pageStep detects a cursor loop", async () => {
            // First page returns messages and sets cursorIsApiId = true
            mockRestAPI.get.mockResolvedValueOnce({
                body: [
                    { id: "1214567890123456789", timestamp: "2024-03-05T12:00:00Z" },
                    { id: "1214567890123456780", timestamp: "2024-03-05T11:00:00Z" }
                ]
            }).mockResolvedValueOnce({
                // Second page returns same or higher cursor (not moving backwards)
                body: [
                    { id: "1214567890123456780", timestamp: "2024-03-05T11:00:00Z" },
                    { id: "1214567890123456785", timestamp: "2024-03-05T11:30:00Z" }
                ]
            });

            await expect(fetchWindow({
                channelId: "chan1",
                filters,
                pageDelayMinMs: 0,
                pageDelayMaxMs: 0
            })).rejects.toThrow(/History paging stopped making progress/);
        });

        it("handles completely missing author and reply without globalName in mapMessage", async () => {
            mockRestAPI.get.mockResolvedValueOnce({
                body: [
                    {
                        id: "100000000000000002",
                        timestamp: "2024-03-05T12:00:00Z",
                        referenced_message: { author: { username: "reply_user" } },
                        attachments: [{}]
                    }
                ]
            }).mockResolvedValueOnce({
                body: []
            });

            const messages = await fetchWindow({
                channelId: "chan1",
                filters,
                pageDelayMinMs: 0,
                pageDelayMaxMs: 0
            });

            expect(messages[0].authorId).toBe("0");
            expect(messages[0].authorName).toBe("unknown");
            expect(messages[0].replyToAuthor).toBe("reply_user");
            expect(messages[0].attachments[0]).toEqual({
                name: "file",
                url: "",
                size: 0,
                contentType: undefined
            });
        });

        it("stops when pageStep returns kind: end on single-item echo", async () => {
            mockRestAPI.get.mockResolvedValueOnce({
                body: [
                    { id: "100000000000000002", timestamp: "2024-03-05T12:00:00Z" },
                    { id: "100000000000000001", timestamp: "2024-03-05T11:00:00Z" }
                ]
            }).mockResolvedValueOnce({
                // cursor is now "100000000000000001" and cursorIsApiId is true
                body: [
                    { id: "100000000000000001", timestamp: "2024-03-05T11:00:00Z" }
                ]
            });

            const messages = await fetchWindow({
                channelId: "chan1",
                filters,
                pageDelayMinMs: 0,
                pageDelayMaxMs: 0
            });

            // The single-item echo was added, and step.kind === "end" broke the loop
            expect(messages).toHaveLength(3);
        });

        it("maps the pinned flag and ignores message types", async () => {
            mockRestAPI.get.mockResolvedValueOnce({
                body: [
                    { id: "100000000000000004", timestamp: "2024-03-05T12:03:00Z", type: 0, pinned: true },
                    { id: "100000000000000003", timestamp: "2024-03-05T12:02:00Z", type: 3, pinned: false },
                    { id: "100000000000000002", timestamp: "2024-03-05T12:01:00Z", type: 19 },
                    { id: "100000000000000001", timestamp: "2024-03-05T12:00:00Z", type: "invalid" }
                ]
            }).mockResolvedValueOnce({ body: [] });

            const messages = await fetchWindow({
                channelId: "chan1",
                filters,
                pageDelayMinMs: 0,
                pageDelayMaxMs: 0
            });

            expect(messages.map(m => m.pinned)).toEqual([true, false, false, false]);
        });

        it("aborts immediately when fetchWindow receives HTTP 400 with captcha_key", async () => {
            mockRestAPI.get.mockRejectedValueOnce({
                status: 400,
                body: { captcha_key: ["captcha-required"] }
            });

            await expect(fetchWindow({
                channelId: "chan1",
                filters,
                pageDelayMinMs: 0,
                pageDelayMaxMs: 0
            })).rejects.toThrow(/Discord requested a captcha/);
        });

        it("retries fetchWindow on HTTP 429 with retryAfter and exponential backoff", async () => {
            vi.useFakeTimers();
            try {
                mockRestAPI.get
                    .mockRejectedValueOnce({ status: 429, retryAfter: 0.5 })
                    .mockResolvedValueOnce({ status: 429, body: { retry_after: 0.25 } })
                    .mockRejectedValueOnce({ status: 429 })
                    .mockResolvedValueOnce({
                        body: [{ id: "100000000000000001", timestamp: "2024-03-05T12:00:00Z", type: 0 }]
                    })
                    .mockResolvedValueOnce({ body: [] });

                const promise = fetchWindow({
                    channelId: "chan1",
                    filters,
                    pageDelayMinMs: 100,
                    pageDelayMaxMs: 200
                });

                await vi.runAllTimersAsync();
                const messages = await promise;
                expect(messages).toHaveLength(1);
                expect(mockRestAPI.get).toHaveBeenCalledTimes(5);
            } finally {
                vi.useRealTimers();
            }
        });

        it("throws when fetchWindow exceeds max 429 rate-limit retries", async () => {
            vi.useFakeTimers();
            try {
                mockRestAPI.get.mockRejectedValue({ status: 429, retryAfter: 0.1 });

                const promise = fetchWindow({
                    channelId: "chan1",
                    filters,
                    pageDelayMinMs: 0,
                    pageDelayMaxMs: 0
                });
                const assertion = expect(promise).rejects.toThrow(/Rate limited while reading history \(page 1\)/);

                await vi.runAllTimersAsync();
                await assertion;
                expect(mockRestAPI.get).toHaveBeenCalledTimes(4);
            } finally {
                vi.useRealTimers();
            }
        });

        it("interrupts fetchWindow 429 backoff sleep immediately when AbortSignal aborts", async () => {
            vi.useFakeTimers();
            try {
                const controller = new AbortController();
                mockRestAPI.get
                    .mockResolvedValueOnce({
                        body: [{ id: "100000000000000002", timestamp: "2024-03-05T12:00:00Z", type: 0 }]
                    })
                    .mockRejectedValueOnce({ status: 429, retryAfter: 60 });

                const promise = fetchWindow({
                    channelId: "chan1",
                    filters,
                    signal: controller.signal,
                    pageDelayMinMs: 0,
                    pageDelayMaxMs: 0
                });

                await Promise.resolve();
                await Promise.resolve();
                await Promise.resolve();
                controller.abort();

                const messages = await promise;
                expect(messages).toHaveLength(1);
            } finally {
                vi.useRealTimers();
            }
        });

        it("rethrows non-429 errors from RestAPI.get and formats non-Error HTTP rejections cleanly", async () => {
            mockRestAPI.get.mockRejectedValueOnce(new Error("Connection reset"));

            await expect(fetchWindow({
                channelId: "chan1",
                filters,
                pageDelayMinMs: 0,
                pageDelayMaxMs: 0
            })).rejects.toThrow("Connection reset");

            mockRestAPI.get.mockRejectedValueOnce({
                status: 403,
                body: { message: "Missing Access" }
            });
            await expect(fetchWindow({
                channelId: "chan1",
                filters,
                pageDelayMinMs: 0,
                pageDelayMaxMs: 0
            })).rejects.toThrow("History request failed (HTTP 403: Missing Access).");

            mockRestAPI.get.mockResolvedValueOnce({
                status: 403,
                body: { message: "Missing Access" }
            });
            await expect(fetchWindow({
                channelId: "chan1",
                filters,
                pageDelayMinMs: 0,
                pageDelayMaxMs: 0
            })).rejects.toThrow("History request failed (HTTP 403: Missing Access).");
        });
    });
});
