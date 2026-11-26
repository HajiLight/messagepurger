import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { settingsStore, mockDiscord, hoistedHolder } = vi.hoisted(() => ({
    settingsStore: {
        target: "123456789012345678",
        mode: "exportThenDelete",
        fromDate: "",
        toDate: "",
        contains: "",
        attachmentMode: "any",
        runCap: "300",
        baseDelayMs: 600,
        excludePinned: true
    } as Record<string, any>,
    mockDiscord: {
        resolveTarget: vi.fn(),
        selfId: vi.fn(),
        fetchWindow: vi.fn(),
        deleteMessage: vi.fn()
    },
    hoistedHolder: {
        pluginSettingsDef: null as any
    }
}));

vi.mock("react/jsx-dev-runtime", () => ({
    jsxDEV: (type: any, props: any) => ({ type, props }),
    jsxs: (type: any, props: any) => ({ type, props }),
    jsx: (type: any, props: any) => ({ type, props })
}));

vi.mock("@api/Settings", () => ({
    definePluginSettings: (def: any) => {
        hoistedHolder.pluginSettingsDef = def;
        return {
            store: settingsStore
        };
    }
}));

vi.mock("@components/Button", () => ({
    Button: (props: any) => props
}));

vi.mock("@utils/types", () => ({
    default: (plugin: any) => plugin,
    OptionType: {
        STRING: "STRING",
        BOOLEAN: "BOOLEAN",
        SELECT: "SELECT",
        SLIDER: "SLIDER",
        COMPONENT: "COMPONENT"
    }
}));

const effectCallbacks: Array<() => (() => void) | void> = [];
const mockSetState = vi.fn();
vi.mock("@webpack/common", () => ({
    useEffect: (fn: () => (() => void) | void) => {
        effectCallbacks.push(fn);
    },
    useState: (val: any) => [val, mockSetState]
}));

vi.mock("../discord", () => mockDiscord);

// Setup browser globals for saveText
const createdBlobs: any[] = [];
const createdAnchors: any[] = [];

globalThis.URL = globalThis.URL || {};
globalThis.URL.createObjectURL = vi.fn((blob: any) => {
    createdBlobs.push(blob);
    return "blob:mock-url";
});
globalThis.URL.revokeObjectURL = vi.fn();

if (typeof document === "undefined") {
    (globalThis as any).document = {
        createElement: (tag: string) => {
            if (tag === "a") {
                const a = {
                    href: "",
                    download: "",
                    click: vi.fn()
                };
                createdAnchors.push(a);
                return a;
            }
            return {};
        }
    };
}

import plugin from "../index";

let testCounter = 1;

describe("MessagePurger plugin (index.tsx)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockDiscord.resolveTarget.mockReset();
        mockDiscord.selfId.mockReset();
        mockDiscord.fetchWindow.mockReset();
        mockDiscord.deleteMessage.mockReset();
        createdBlobs.length = 0;
        createdAnchors.length = 0;
        effectCallbacks.length = 0;
        mockSetState.mockReset();

        const uniqueId = `1234567890123456${String(testCounter++).padStart(2, "0")}`;
        settingsStore.target = uniqueId;
        settingsStore.mode = "exportThenDelete";
        settingsStore.fromDate = "";
        settingsStore.toDate = "";
        settingsStore.contains = "";
        settingsStore.attachmentMode = "any";
        settingsStore.runCap = "300";
        settingsStore.baseDelayMs = 600;
        settingsStore.excludePinned = true;
        settingsStore.verifyAfterRun = false;

        mockDiscord.resolveTarget.mockReturnValue({
            channelId: uniqueId,
            kind: "dm",
            label: `Test DM ${uniqueId}`
        });
        mockDiscord.selfId.mockReturnValue("111111111111111111");
    });

    it("has plugin metadata and lifecycle hooks", () => {
        expect(plugin.name).toBe("MessagePurger");
        expect(plugin.authors[0].name).toBe("HajiLight");
        expect(hoistedHolder.pluginSettingsDef.excludePinned.default).toBe(false);
        expect(hoistedHolder.pluginSettingsDef.excludePinned.type).toBe("BOOLEAN");
        expect(typeof plugin.scan).toBe("function");
        expect(typeof plugin.exportFiles).toBe("function");
        expect(typeof plugin.startRun).toBe("function");
        expect(typeof plugin.stopRun).toBe("function");
        expect(typeof plugin.getState).toBe("function");
        expect(typeof plugin.stop).toBe("function");
    });

    describe("scan (Preview)", () => {
        it("previews messages and counts user vs other messages", async () => {
            mockDiscord.fetchWindow.mockResolvedValueOnce([
                {
                    id: "msg1",
                    authorId: "111111111111111111",
                    authorName: "HajiLight",
                    timestamp: 1709640000000,
                    content: "mine",
                    attachments: [],
                    embedCount: 0
                },
                {
                    id: "msg2",
                    authorId: "222222222222222222",
                    authorName: "Other",
                    timestamp: 1709640001000,
                    content: "theirs",
                    attachments: [],
                    embedCount: 0
                }
            ]);

            const ok = await plugin.scan();
            expect(ok).toBe(true);

            const st = plugin.getState();
            expect(st.phase).toBe("ready");
            expect(st.total).toBe(2);
            expect(st.note).toContain("2 messages in range — 1 yours, 1 from the other side.");
        });

        it("says how many call entries were skipped", async () => {
            mockDiscord.fetchWindow.mockResolvedValueOnce([
                {
                    id: "call",
                    authorId: "111111111111111111",
                    authorName: "HajiLight",
                    timestamp: 1709640000000,
                    content: "",
                    attachments: [],
                    embedCount: 0,
                    type: 3
                },
                {
                    id: "msg1",
                    authorId: "111111111111111111",
                    authorName: "HajiLight",
                    timestamp: 1709640001000,
                    content: "mine",
                    attachments: [],
                    embedCount: 0,
                    type: 0
                }
            ]);

            const ok = await plugin.scan();
            expect(ok).toBe(true);

            const st = plugin.getState();
            expect(st.total).toBe(2);
            expect(st.skipped).toBe(1);
            expect(st.note).toContain("1 call message among yours is skipped — not in the delete count.");
        });

        it("handles 0 messages found", async () => {
            mockDiscord.fetchWindow.mockResolvedValueOnce([]);
            const ok = await plugin.scan();
            expect(ok).toBe(true);

            const st = plugin.getState();
            expect(st.phase).toBe("ready");
            expect(st.note).toContain("No messages found");
        });

        it("handles missing selfId", async () => {
            mockDiscord.selfId.mockReturnValue("");
            mockDiscord.fetchWindow.mockResolvedValueOnce([
                { id: "1", authorId: "1", authorName: "X", timestamp: 1, content: "hi", attachments: [], embedCount: 0 }
            ]);

            const ok = await plugin.scan();
            expect(ok).toBe(false);
            expect(plugin.getState().phase).toBe("error");
            expect(plugin.getState().note).toContain("Discord has not finished loading your account");
        });

        it("rejects unsupported channel types like group DMs", async () => {
            mockDiscord.resolveTarget.mockReturnValue({
                channelId: "123456789012345678",
                kind: "group",
                label: "Group Chat"
            });

            const ok = await plugin.scan();
            expect(ok).toBe(false);
            expect(plugin.getState().phase).toBe("error");
            expect(plugin.getState().note).toContain("private chats and server text channels");
        });

        it("handles fetchWindow error", async () => {
            mockDiscord.fetchWindow.mockRejectedValueOnce(new Error("Network failed"));

            const ok = await plugin.scan();
            expect(ok).toBe(false);
            expect(plugin.getState().phase).toBe("error");
            expect(plugin.getState().note).toBe("Network failed");
        });

        it("stops scan when cancelled", async () => {
            mockDiscord.fetchWindow.mockImplementation(async (opts: any) => {
                expect(opts.isCancelled()).toBe(false);
                plugin.stop();
                expect(opts.isCancelled()).toBe(true);
                return [];
            });

            const ok = await plugin.scan();
            expect(ok).toBe(false);
            expect(plugin.getState().phase).toBe("stopped");
        });
    });

    describe("exportFiles", () => {
        it("triggers scan and saves jsonl and txt files", async () => {
            mockDiscord.fetchWindow.mockResolvedValueOnce([
                {
                    id: "msg1",
                    authorId: "111111111111111111",
                    authorName: "HajiLight",
                    timestamp: 1709640000000,
                    content: "export me",
                    attachments: [],
                    embedCount: 0
                }
            ]);

            const ok = await plugin.exportFiles();
            expect(ok).toBe(true);
            expect(createdAnchors.length).toBe(2);
            expect(createdAnchors[0].download).toContain(".jsonl");
            expect(createdAnchors[1].download).toContain(".txt");
            expect(plugin.getState().phase).toBe("ready");
            expect(plugin.getState().note).toContain("Offered 1 messages");
        });

        it("handles invalid context during export", async () => {
            settingsStore.fromDate = "invalid-date";
            const ok = await plugin.exportFiles();
            expect(ok).toBe(false);
            expect(plugin.getState().phase).toBe("error");
        });
    });

    describe("startRun (delete & export orchestration)", () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it("handles mode 'export' directly", async () => {
            settingsStore.mode = "export";
            mockDiscord.fetchWindow.mockResolvedValueOnce([
                {
                    id: "msg1",
                    authorId: "111111111111111111",
                    authorName: "HajiLight",
                    timestamp: 1709640000000,
                    content: "export only",
                    attachments: [],
                    embedCount: 0
                }
            ]);

            await plugin.startRun();
            expect(createdAnchors.length).toBe(2);
        });

        it("handles deleteOnly: arming first, then confirmation deleting", async () => {
            settingsStore.mode = "deleteOnly";
            mockDiscord.fetchWindow.mockResolvedValue([
                {
                    id: "msg1",
                    authorId: "111111111111111111",
                    authorName: "HajiLight",
                    timestamp: 1709640000000,
                    content: "delete me 1",
                    attachments: [],
                    embedCount: 0,
                },
                {
                    id: "msg2",
                    authorId: "111111111111111111",
                    authorName: "HajiLight",
                    timestamp: 1709640001000,
                    content: "delete me 2",
                    attachments: [],
                    embedCount: 0,
                }
            ]);

            // First press: arms the run
            await plugin.startRun();
            expect(plugin.getState().note).toContain("About to delete 2 of your messages");
            expect(plugin.getState().queued).toBe(2);

            // Fast press (< 1500 ms): returns 'soon'
            await vi.advanceTimersByTimeAsync(500);
            await plugin.startRun();
            expect(plugin.getState().note).toContain("Armed — press Start once more to confirm.");

            // Second valid press (after minimum gap, e.g. 2000 ms): confirms and runs deletion
            await vi.advanceTimersByTimeAsync(2000);
            mockDiscord.deleteMessage
                .mockResolvedValueOnce({ outcome: "deleted", status: 204 })
                .mockResolvedValueOnce({ outcome: "gone", status: 404 });

            const startPromise = plugin.startRun();
            await vi.runAllTimersAsync();
            await startPromise;

            const st = plugin.getState();
            expect(st.phase).toBe("done");
            expect(st.deleted).toBe(1);
            expect(st.gone).toBe(1);
            expect(st.note).toContain("Finished — 1 deleted, 1 already gone");
        });

        it("handles exportThenDelete mode and reuses offer after confirm window expires", async () => {
            settingsStore.mode = "exportThenDelete";
            mockDiscord.fetchWindow.mockResolvedValue([
                {
                    id: "msg1",
                    authorId: "111111111111111111",
                    authorName: "HajiLight",
                    timestamp: 1709640000000,
                    content: "msg",
                    attachments: [],
                    embedCount: 0,
                }
            ]);

            // First press: exports files and arms
            await plugin.startRun();
            expect(createdAnchors.length).toBe(2);
            expect(plugin.getState().note).toContain("Backup offered");

            // Expire the 60s arm window, stay inside the 10-minute offer reuse window
            await vi.advanceTimersByTimeAsync(65_000);
            await plugin.startRun();
            // Offer reused — no second pair of export dialogs
            expect(createdAnchors.length).toBe(2);
            expect(plugin.getState().note).toContain("Backup offered");

            // Wait 2 seconds (so minimum gap passes) and confirm
            await vi.advanceTimersByTimeAsync(2000);
            mockDiscord.deleteMessage.mockResolvedValueOnce({ outcome: "deleted", status: 204 });
            const deletePromise = plugin.startRun();
            await vi.runAllTimersAsync();
            await deletePromise;

            expect(plugin.getState().phase).toBe("done");
            expect(plugin.getState().deleted).toBe(1);
        });

        it("handles rate limiting during deletion and retries up to max", async () => {
            settingsStore.mode = "deleteOnly";
            mockDiscord.fetchWindow.mockResolvedValue([
                {
                    id: "msg1",
                    authorId: "111111111111111111",
                    authorName: "HajiLight",
                    timestamp: 1709640000000,
                    content: "delete me",
                    attachments: [],
                    embedCount: 0,
                }
            ]);

            await plugin.startRun();
            await vi.advanceTimersByTimeAsync(2000);

            mockDiscord.deleteMessage
                .mockResolvedValueOnce({ outcome: "rate_limited", status: 429, retryAfterMs: 500 })
                .mockResolvedValueOnce({ outcome: "deleted", status: 204 });

            const deletePromise = plugin.startRun();
            await vi.runAllTimersAsync();
            await deletePromise;

            const st = plugin.getState();
            expect(st.phase).toBe("done");
            // A 429 that is then deleted is a message that waited, not one still throttled:
            // the counter only describes leftovers after every retry.
            expect(st.throttled).toBe(0);
            expect(st.failed).toBe(0);
            expect(st.deleted).toBe(1);
            expect(st.note).not.toContain("throttled");
        });

        it("counts one message as throttled however many times it waited", async () => {
            settingsStore.mode = "deleteOnly";
            mockDiscord.fetchWindow.mockResolvedValue([
                {
                    id: "msg1",
                    authorId: "111111111111111111",
                    authorName: "HajiLight",
                    timestamp: 1709640000000,
                    content: "delete me",
                    attachments: [],
                    embedCount: 0,
                }
            ]);

            await plugin.startRun();
            await vi.advanceTimersByTimeAsync(2000);

            mockDiscord.deleteMessage.mockResolvedValue({ outcome: "rate_limited", status: 429, retryAfterMs: 200 });

            const deletePromise = plugin.startRun();
            await vi.runAllTimersAsync();
            await deletePromise;

            const st = plugin.getState();
            expect(st.phase).toBe("done");
            expect(st.throttled).toBe(1);
            expect(st.failed).toBe(1);
            expect(mockDiscord.deleteMessage).toHaveBeenCalledTimes(4);
        });

        it("handles cancellation during deletion", async () => {
            settingsStore.mode = "deleteOnly";
            mockDiscord.fetchWindow.mockResolvedValue([
                {
                    id: "msg1",
                    authorId: "111111111111111111",
                    authorName: "HajiLight",
                    timestamp: 1709640000000,
                    content: "msg1",
                    attachments: [],
                    embedCount: 0,
                },
                {
                    id: "msg2",
                    authorId: "111111111111111111",
                    authorName: "HajiLight",
                    timestamp: 1709640001000,
                    content: "msg2",
                    attachments: [],
                    embedCount: 0,
                }
            ]);

            await plugin.startRun();
            await vi.advanceTimersByTimeAsync(2000);

            mockDiscord.deleteMessage.mockImplementation(async () => {
                plugin.stopRun();
                return { outcome: "deleted", status: 204 };
            });

            const deletePromise = plugin.startRun();
            await vi.runAllTimersAsync();
            await deletePromise;

            expect(plugin.getState().phase).toBe("stopped");
        });

        it("interrupts sleep immediately when stopRun is called during pacing pause", async () => {
            settingsStore.mode = "deleteOnly";
            settingsStore.baseDelayMs = 4000;
            mockDiscord.fetchWindow.mockResolvedValue([
                {
                    id: "msg1",
                    authorId: "111111111111111111",
                    authorName: "HajiLight",
                    timestamp: 1709640000000,
                    content: "msg1",
                    attachments: [],
                    embedCount: 0,
                },
                {
                    id: "msg2",
                    authorId: "111111111111111111",
                    authorName: "HajiLight",
                    timestamp: 1709640001000,
                    content: "msg2",
                    attachments: [],
                    embedCount: 0,
                }
            ]);

            await plugin.startRun();
            await vi.advanceTimersByTimeAsync(2000);

            const deletePromise = plugin.startRun();
            // Still inside the pre-deletion sleep (2400..5600ms): advance only 50ms and abort
            await vi.advanceTimersByTimeAsync(50);
            expect(plugin.getState().phase).toBe("deleting");
            expect(mockDiscord.deleteMessage).not.toHaveBeenCalled();

            plugin.stopRun();
            expect(plugin.getState().note).toBe("Stopping…");

            // Must resolve immediately without advancing timers through the full delay
            await deletePromise;
            expect(plugin.getState().phase).toBe("stopped");
            expect(mockDiscord.deleteMessage).not.toHaveBeenCalled();
        });

        it("aborts deletion immediately on circuit breaker after 3 consecutive 403/401 responses", async () => {
            settingsStore.mode = "deleteOnly";
            mockDiscord.fetchWindow.mockResolvedValue([
                { id: "m1", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 1, content: "1", attachments: [], embedCount: 0 },
                { id: "m2", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 2, content: "2", attachments: [], embedCount: 0 },
                { id: "m3", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 3, content: "3", attachments: [], embedCount: 0 },
                { id: "m4", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 4, content: "4", attachments: [], embedCount: 0 }
            ]);

            await plugin.startRun();
            await vi.advanceTimersByTimeAsync(2000);

            mockDiscord.deleteMessage
                .mockResolvedValueOnce({ outcome: "forbidden", status: 403 })
                .mockResolvedValueOnce({ outcome: "failed", status: 401 })
                .mockResolvedValueOnce({ outcome: "forbidden", status: 403 })
                .mockResolvedValueOnce({ outcome: "deleted", status: 204 });

            const deletePromise = plugin.startRun();
            await vi.runAllTimersAsync();
            await deletePromise;

            const st = plugin.getState();
            expect(st.phase).toBe("error");
            expect(st.note).toContain("circuit breaker");
            expect(st.forbidden).toBe(2);
            expect(st.failed).toBe(1);
            expect(mockDiscord.deleteMessage).toHaveBeenCalledTimes(3);
        });

        it("resets circuit breaker counter when a non-401/403 response occurs in between", async () => {
            settingsStore.mode = "deleteOnly";
            mockDiscord.fetchWindow.mockResolvedValue([
                { id: "m1", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 1, content: "1", attachments: [], embedCount: 0 },
                { id: "m2", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 2, content: "2", attachments: [], embedCount: 0 },
                { id: "m3", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 3, content: "3", attachments: [], embedCount: 0 },
                { id: "m4", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 4, content: "4", attachments: [], embedCount: 0 },
                { id: "m5", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 5, content: "5", attachments: [], embedCount: 0 }
            ]);

            await plugin.startRun();
            await vi.advanceTimersByTimeAsync(2000);

            mockDiscord.deleteMessage
                .mockResolvedValueOnce({ outcome: "forbidden", status: 403 })
                .mockResolvedValueOnce({ outcome: "forbidden", status: 403 })
                .mockResolvedValueOnce({ outcome: "deleted", status: 204 })
                .mockResolvedValueOnce({ outcome: "forbidden", status: 403 })
                .mockResolvedValueOnce({ outcome: "failed", status: 401 });

            const deletePromise = plugin.startRun();
            await vi.runAllTimersAsync();
            await deletePromise;

            const st = plugin.getState();
            expect(st.phase).toBe("done");
            expect(st.deleted).toBe(1);
            expect(st.forbidden).toBe(3);
            expect(st.failed).toBe(1);
            expect(mockDiscord.deleteMessage).toHaveBeenCalledTimes(5);
        });

        it("verifies after a run and says nothing of yours is left", async () => {
            settingsStore.mode = "deleteOnly";
            settingsStore.verifyAfterRun = true;
            mockDiscord.fetchWindow
                .mockResolvedValueOnce([
                    { id: "m1", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 1, content: "1", attachments: [], embedCount: 0 },
                    { id: "m2", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 2, content: "2", attachments: [], embedCount: 0 }
                ])
                .mockResolvedValueOnce([]);

            await plugin.scan();
            await plugin.startRun();
            await vi.advanceTimersByTimeAsync(2000);
            mockDiscord.deleteMessage.mockResolvedValue({ outcome: "deleted", status: 204 });

            const deletePromise = plugin.startRun();
            await vi.runAllTimersAsync();
            await deletePromise;

            const st = plugin.getState();
            expect(st.phase).toBe("done");
            expect(st.deleted).toBe(2);
            expect(st.note).toContain("Finished — 2 deleted, 0 already gone, 0 refused, 0 failed.");
            expect(st.note).toContain("Verified: nothing of yours matching that range is left.");
            expect(mockDiscord.fetchWindow).toHaveBeenCalledTimes(2);
        });

        it("does not claim the range is empty while a call entry remains", async () => {
            settingsStore.mode = "deleteOnly";
            settingsStore.verifyAfterRun = true;
            const call = { id: "call", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 2, content: "", attachments: [], embedCount: 0, type: 3 };
            mockDiscord.fetchWindow
                .mockResolvedValueOnce([
                    { id: "m1", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 1, content: "1", attachments: [], embedCount: 0, type: 0 },
                    call
                ])
                .mockResolvedValueOnce([call]);

            await plugin.scan();
            await plugin.startRun();
            await vi.advanceTimersByTimeAsync(2000);
            mockDiscord.deleteMessage.mockResolvedValue({ outcome: "deleted", status: 204 });

            const deletePromise = plugin.startRun();
            await vi.runAllTimersAsync();
            await deletePromise;

            const st = plugin.getState();
            expect(st.phase).toBe("done");
            expect(st.deleted).toBe(1);
            expect(st.skipped).toBe(1);
            expect(st.note).toContain("Verified: nothing left to delete — 1 of your call messages left in the range");
            expect(st.note).not.toContain("nothing of yours matching that range is left");
            expect(mockDiscord.deleteMessage).toHaveBeenCalledTimes(1);
            expect(mockDiscord.deleteMessage).toHaveBeenCalledWith(expect.any(String), "m1");
            expect(mockDiscord.deleteMessage).not.toHaveBeenCalledWith(expect.any(String), "call");
        });

        it("retries a transport failure once and verifies what is still there", async () => {
            settingsStore.mode = "deleteOnly";
            settingsStore.verifyAfterRun = true;
            const messages = [
                { id: "m1", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 1, content: "1", attachments: [], embedCount: 0 },
                { id: "m2", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 2, content: "2", attachments: [], embedCount: 0 }
            ];
            mockDiscord.fetchWindow
                .mockResolvedValueOnce(messages)
                .mockResolvedValueOnce(messages);

            await plugin.scan();
            await plugin.startRun();
            await vi.advanceTimersByTimeAsync(2000);

            // Network-shaped failure on the first message (no status), success on the retry.
            mockDiscord.deleteMessage
                .mockResolvedValueOnce({ outcome: "failed" })
                .mockResolvedValueOnce({ outcome: "deleted", status: 204 })
                .mockResolvedValueOnce({ outcome: "deleted", status: 204 });

            const deletePromise = plugin.startRun();
            await vi.runAllTimersAsync();
            await deletePromise;

            const st = plugin.getState();
            expect(st.failed).toBe(0);
            expect(st.deleted).toBe(2);
            expect(mockDiscord.deleteMessage).toHaveBeenCalledTimes(3);
            expect(st.note).toContain("Verified:");
        });

        it("does not retry an HTTP 4xx failure", async () => {
            settingsStore.mode = "deleteOnly";
            settingsStore.verifyAfterRun = true;
            const refused = { id: "m1", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 1, content: "1", attachments: [], embedCount: 0 };
            mockDiscord.fetchWindow
                .mockResolvedValueOnce([refused])
                .mockResolvedValueOnce([refused]);

            await plugin.scan();
            await plugin.startRun();
            await vi.advanceTimersByTimeAsync(2000);
            mockDiscord.deleteMessage.mockResolvedValue({ outcome: "failed", status: 400 });

            const deletePromise = plugin.startRun();
            await vi.runAllTimersAsync();
            await deletePromise;

            const st = plugin.getState();
            expect(st.phase).toBe("done");
            expect(st.failed).toBe(1);
            expect(st.note).toContain("Finished — 0 deleted, 0 already gone, 0 refused, 1 failed.");
            expect(st.note).toContain("answered with a 4xx (never retried)");
            expect(mockDiscord.deleteMessage).toHaveBeenCalledTimes(1);
        });

        it("separates a kept pin from what is really left", async () => {
            settingsStore.mode = "deleteOnly";
            settingsStore.verifyAfterRun = true;
            settingsStore.excludePinned = true;
            const keptPin = { id: "pinned", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 2, content: "pin", attachments: [], embedCount: 0, pinned: true };
            mockDiscord.fetchWindow
                .mockResolvedValueOnce([
                    { id: "m1", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 1, content: "1", attachments: [], embedCount: 0 },
                    keptPin
                ])
                .mockResolvedValueOnce([keptPin]);

            await plugin.scan();
            await plugin.startRun();
            await vi.advanceTimersByTimeAsync(2000);
            mockDiscord.deleteMessage.mockResolvedValue({ outcome: "deleted", status: 204 });

            const deletePromise = plugin.startRun();
            await vi.runAllTimersAsync();
            await deletePromise;

            const st = plugin.getState();
            expect(st.deleted).toBe(1);
            expect(st.note).toContain("Verified: nothing left to delete — 1 pinned left in the range (excludePinned is on).");
        });

        it("says verification is off when the setting is disabled", async () => {
            settingsStore.mode = "deleteOnly";
            settingsStore.verifyAfterRun = false;
            mockDiscord.fetchWindow.mockResolvedValueOnce([
                { id: "m1", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 1, content: "1", attachments: [], embedCount: 0 }
            ]);

            await plugin.scan();
            await plugin.startRun();
            await vi.advanceTimersByTimeAsync(2000);
            mockDiscord.deleteMessage.mockResolvedValue({ outcome: "deleted", status: 204 });

            const deletePromise = plugin.startRun();
            await vi.runAllTimersAsync();
            await deletePromise;

            expect(plugin.getState().note).toContain("(verification is off).");
            expect(mockDiscord.fetchWindow).toHaveBeenCalledTimes(1);
        });

        it("aborts when a captcha arrives during the retry pass", async () => {
            settingsStore.mode = "deleteOnly";
            settingsStore.verifyAfterRun = true;
            // ONE message: the main loop sees a transport failure, the retry pass gets the captcha.
            mockDiscord.fetchWindow.mockResolvedValueOnce([
                { id: "m1", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 1, content: "1", attachments: [], embedCount: 0 }
            ]);

            await plugin.scan();
            await plugin.startRun();
            await vi.advanceTimersByTimeAsync(2000);

            mockDiscord.deleteMessage
                .mockResolvedValueOnce({ outcome: "failed" })
                .mockResolvedValueOnce({ outcome: "captcha", status: 400 });

            const deletePromise = plugin.startRun();
            await vi.runAllTimersAsync();
            await deletePromise;

            const st = plugin.getState();
            expect(st.phase).toBe("error");
            expect(st.note).toContain("Discord requested a captcha");
            // exactly two requests: the first attempt and the retry that saw the captcha
            expect(mockDiscord.deleteMessage).toHaveBeenCalledTimes(2);
            // and no verification read may follow a captcha
            expect(mockDiscord.fetchWindow).toHaveBeenCalledTimes(1);
        });

        it("moves a retry that answers 4xx into the refusal bucket", async () => {
            settingsStore.mode = "deleteOnly";
            settingsStore.verifyAfterRun = true;
            const message = { id: "m1", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 1, content: "1", attachments: [], embedCount: 0 };
            mockDiscord.fetchWindow
                .mockResolvedValueOnce([message])
                .mockResolvedValueOnce([message]);

            await plugin.scan();
            await plugin.startRun();
            await vi.advanceTimersByTimeAsync(2000);
            mockDiscord.deleteMessage
                .mockResolvedValueOnce({ outcome: "failed" })
                .mockResolvedValueOnce({ outcome: "failed", status: 400 });

            const deletePromise = plugin.startRun();
            await vi.runAllTimersAsync();
            await deletePromise;

            const st = plugin.getState();
            expect(st.note).toContain("1 answered with a 4xx (never retried)");
            expect(st.note).not.toContain("still failing after one retry");
        });

        it("keeps phase error when the verification read hits a captcha", async () => {
            settingsStore.mode = "deleteOnly";
            settingsStore.verifyAfterRun = true;
            mockDiscord.fetchWindow
                .mockResolvedValueOnce([
                    { id: "m1", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 1, content: "1", attachments: [], embedCount: 0 }
                ])
                .mockRejectedValueOnce(new Error("Discord requested a captcha — reading aborted to protect your account."));

            await plugin.scan();
            await plugin.startRun();
            await vi.advanceTimersByTimeAsync(2000);
            mockDiscord.deleteMessage.mockResolvedValue({ outcome: "deleted", status: 204 });

            const deletePromise = plugin.startRun();
            await vi.runAllTimersAsync();
            await deletePromise;

            const st = plugin.getState();
            expect(st.phase).toBe("error");
            expect(st.note).toContain("verification failed");
            expect(st.note).toContain("captcha");
        });

        it("treats status 0 as a transport failure and retries it", async () => {
            settingsStore.mode = "deleteOnly";
            settingsStore.verifyAfterRun = true;
            const message = { id: "m1", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 1, content: "1", attachments: [], embedCount: 0 };
            mockDiscord.fetchWindow
                .mockResolvedValueOnce([message])
                .mockResolvedValueOnce([]);

            await plugin.scan();
            await plugin.startRun();
            await vi.advanceTimersByTimeAsync(2000);
            mockDiscord.deleteMessage
                .mockResolvedValueOnce({ outcome: "failed", status: 0 })
                .mockResolvedValueOnce({ outcome: "deleted", status: 204 });

            const deletePromise = plugin.startRun();
            await vi.runAllTimersAsync();
            await deletePromise;

            const st = plugin.getState();
            expect(st.deleted).toBe(1);
            expect(st.failed).toBe(0);
            expect(mockDiscord.deleteMessage).toHaveBeenCalledTimes(2);
        });

        it("calls a retry that stays rate-limited throttled, not failing", async () => {
            settingsStore.mode = "deleteOnly";
            settingsStore.verifyAfterRun = true;
            const message = { id: "m1", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 1, content: "1", attachments: [], embedCount: 0 };
            mockDiscord.fetchWindow
                .mockResolvedValueOnce([message])
                .mockResolvedValueOnce([message]);

            await plugin.scan();
            await plugin.startRun();
            await vi.advanceTimersByTimeAsync(2000);
            mockDiscord.deleteMessage
                .mockResolvedValueOnce({ outcome: "failed" })
                .mockResolvedValue({ outcome: "rate_limited", retryAfterMs: 1 });

            const deletePromise = plugin.startRun();
            await vi.runAllTimersAsync();
            await deletePromise;

            const st = plugin.getState();
            expect(st.note).toContain("1 still rate-limited after their retries");
            expect(st.note).not.toContain("still failing after one retry");
        });

        it("says a cap run withheld messages, with the counts", async () => {
            settingsStore.mode = "deleteOnly";
            settingsStore.verifyAfterRun = true;
            settingsStore.runCap = "2";
            const all = [
                { id: "m1", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 1, content: "1", attachments: [], embedCount: 0 },
                { id: "m2", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 2, content: "2", attachments: [], embedCount: 0 },
                { id: "m3", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 3, content: "3", attachments: [], embedCount: 0 },
                { id: "m4", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 4, content: "4", attachments: [], embedCount: 0 }
            ];
            mockDiscord.fetchWindow
                .mockResolvedValueOnce(all)
                .mockResolvedValueOnce(all.slice(2));

            await plugin.scan();
            await plugin.startRun();
            await vi.advanceTimersByTimeAsync(2000);
            mockDiscord.deleteMessage.mockResolvedValue({ outcome: "deleted", status: 204 });

            const deletePromise = plugin.startRun();
            await vi.runAllTimersAsync();
            await deletePromise;

            const st = plugin.getState();
            expect(st.deleted).toBe(2);
            expect(st.note).toContain("2 of 4 were queued; the cap stopped this run, preview again for the rest.");
            expect(st.note).not.toContain("nothing of yours matching that range is left");
            expect(st.note).not.toContain("arrived during the run");
        });

        it("does not call a rate-limited leftover a new message", async () => {
            settingsStore.mode = "deleteOnly";
            settingsStore.verifyAfterRun = true;
            settingsStore.runCap = "300";
            const message = { id: "m1", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 1, content: "1", attachments: [], embedCount: 0 };
            mockDiscord.fetchWindow
                .mockResolvedValueOnce([message])
                .mockResolvedValueOnce([message]);

            await plugin.scan();
            await plugin.startRun();
            await vi.advanceTimersByTimeAsync(2000);
            // always throttled: attempt() gives up after MAX_RATE_LIMIT_RETRIES
            mockDiscord.deleteMessage.mockResolvedValue({ outcome: "rate_limited", retryAfterMs: 1 });

            const deletePromise = plugin.startRun();
            await vi.runAllTimersAsync();
            await deletePromise;

            const st = plugin.getState();
            expect(st.note).toContain("1 still rate-limited after their retries");
            expect(st.note).not.toContain("arrived during the run");
        });

        it("names a 4xx leftover as refused, not as a new arrival", async () => {
            settingsStore.mode = "deleteOnly";
            settingsStore.verifyAfterRun = true;
            const refused = { id: "m1", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 1, content: "1", attachments: [], embedCount: 0 };
            mockDiscord.fetchWindow
                .mockResolvedValueOnce([refused])
                .mockResolvedValueOnce([refused]);

            await plugin.scan();
            await plugin.startRun();
            await vi.advanceTimersByTimeAsync(2000);
            mockDiscord.deleteMessage.mockResolvedValue({ outcome: "failed", status: 400 });

            const deletePromise = plugin.startRun();
            await vi.runAllTimersAsync();
            await deletePromise;

            const st = plugin.getState();
            expect(st.phase).toBe("done");
            expect(st.failed).toBe(1);
            expect(st.note).toContain("1 answered with a 4xx (never retried)");
            expect(st.note).not.toContain("arrived during the run");
        });

        it("makes no completeness claim when Stop lands during the verification read", async () => {
            settingsStore.mode = "deleteOnly";
            settingsStore.verifyAfterRun = true;
            mockDiscord.fetchWindow
                .mockResolvedValueOnce([
                    { id: "m1", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 1, content: "1", attachments: [], embedCount: 0 }
                ])
                .mockImplementationOnce(async () => {
                    plugin.stopRun();
                    return [];
                });

            await plugin.scan();
            await plugin.startRun();
            await vi.advanceTimersByTimeAsync(2000);
            mockDiscord.deleteMessage.mockResolvedValue({ outcome: "deleted", status: 204 });

            const deletePromise = plugin.startRun();
            await vi.runAllTimersAsync();
            await deletePromise;

            const st = plugin.getState();
            expect(st.phase).toBe("stopped");
            expect(st.note).toContain("Nothing was verified");
            expect(st.note).not.toContain("Verified: nothing of yours");
        });

        it("reports a failed verification as a failed check, not a failed run", async () => {
            settingsStore.mode = "deleteOnly";
            settingsStore.verifyAfterRun = true;
            mockDiscord.fetchWindow
                .mockResolvedValueOnce([
                    { id: "m1", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 1, content: "1", attachments: [], embedCount: 0 }
                ])
                .mockRejectedValueOnce(new Error("Rate limited while reading history"));

            await plugin.scan();
            await plugin.startRun();
            await vi.advanceTimersByTimeAsync(2000);
            mockDiscord.deleteMessage.mockResolvedValue({ outcome: "deleted", status: 204 });

            const deletePromise = plugin.startRun();
            await vi.runAllTimersAsync();
            await deletePromise;

            const st = plugin.getState();
            expect(st.phase).toBe("done");
            expect(st.deleted).toBe(1);
            expect(st.note).toContain("verification failed");
            expect(st.note).not.toContain("Run stopped by an error");
        });

        it("aborts deletion immediately on captcha_key response", async () => {
            settingsStore.mode = "deleteOnly";
            mockDiscord.fetchWindow.mockResolvedValue([
                { id: "m1", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 1, content: "1", attachments: [], embedCount: 0 },
                { id: "m2", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 2, content: "2", attachments: [], embedCount: 0 }
            ]);

            await plugin.startRun();
            await vi.advanceTimersByTimeAsync(2000);

            mockDiscord.deleteMessage
                .mockResolvedValueOnce({ outcome: "captcha", status: 400 })
                .mockResolvedValueOnce({ outcome: "deleted", status: 204 });

            const deletePromise = plugin.startRun();
            await vi.runAllTimersAsync();
            await deletePromise;

            const st = plugin.getState();
            expect(st.phase).toBe("error");
            expect(st.note).toContain("Discord requested a captcha");
            expect(st.failed).toBe(1);
            expect(mockDiscord.deleteMessage).toHaveBeenCalledTimes(1);
        });

        it("queues every one of your messages and respects the excludePinned setting", async () => {
            settingsStore.mode = "deleteOnly";
            settingsStore.excludePinned = true;
            mockDiscord.fetchWindow.mockResolvedValue([
                { id: "m1", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 1, content: "normal", attachments: [], embedCount: 0, pinned: false },
                { id: "m2", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 2, content: "pinned", attachments: [], embedCount: 0, pinned: true },
                { id: "m3", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 3, content: "call", attachments: [], embedCount: 0, pinned: false },
                { id: "m4", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 4, content: "sys", attachments: [], embedCount: 0, pinned: false }
            ]);

            await plugin.startRun();
            expect(plugin.getState().total).toBe(4);
            expect(plugin.getState().queued).toBe(3);

            // Toggle excludePinned after arming: must re-arm with refreshed count (2) instead of deleting
            await vi.advanceTimersByTimeAsync(2000);
            settingsStore.excludePinned = false;
            await plugin.startRun();
            expect(plugin.getState().queued).toBe(4);
            expect(plugin.getState().note).toContain("Settings changed after you armed it");
            expect(mockDiscord.deleteMessage).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(2000);
            mockDiscord.deleteMessage.mockResolvedValue({ outcome: "deleted", status: 204 });
            const deletePromise = plugin.startRun();
            await vi.runAllTimersAsync();
            await deletePromise;
            expect(plugin.getState().deleted).toBe(4);
        });

        it("re-scans when target or filters change after preview, and falls back unknown mode to exportThenDelete", async () => {
            settingsStore.mode = "unknownMode";
            mockDiscord.fetchWindow
                .mockResolvedValueOnce([
                    { id: "m1", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 1, content: "first", attachments: [], embedCount: 0 }
                ])
                .mockResolvedValueOnce([
                    { id: "m2", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 2, content: "second", attachments: [], embedCount: 0 }
                ]);

            await plugin.scan();
            expect(plugin.getState().total).toBe(1);

            // Change target after preview
            settingsStore.target = "999999999999999999";
            mockDiscord.resolveTarget.mockReturnValue({
                channelId: "999999999999999999",
                kind: "dm",
                label: "New DM"
            });

            await plugin.startRun();
            expect(mockDiscord.fetchWindow).toHaveBeenCalledTimes(2);
            // Unknown mode fell back to exportThenDelete, so both files were offered
            expect(createdAnchors.length).toBe(2);
            expect(plugin.getState().note).toContain("Backup offered");
        });

        it("scans only once when target changes after preview to an empty channel", async () => {
            settingsStore.mode = "deleteOnly";
            mockDiscord.fetchWindow
                .mockResolvedValueOnce([
                    { id: "m1", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 1, content: "first", attachments: [], embedCount: 0 }
                ])
                .mockResolvedValueOnce([]);

            await plugin.scan();
            expect(plugin.getState().total).toBe(1);

            settingsStore.target = "888888888888888888";
            mockDiscord.resolveTarget.mockReturnValue({
                channelId: "888888888888888888",
                kind: "dm",
                label: "Empty DM"
            });

            await plugin.startRun();
            expect(mockDiscord.fetchWindow).toHaveBeenCalledTimes(2);
            expect(plugin.getState().phase).toBe("ready");
            expect(plugin.getState().note).toContain("No messages found for Empty DM");
        });

        it("invalidates previous backup offer when a fresh scan runs", async () => {
            settingsStore.mode = "exportThenDelete";
            mockDiscord.fetchWindow
                .mockResolvedValueOnce([
                    { id: "m1", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 1, content: "old", attachments: [], embedCount: 0 }
                ])
                .mockResolvedValueOnce([
                    { id: "m1", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 1, content: "old", attachments: [], embedCount: 0 },
                    { id: "m2", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 2, content: "new", attachments: [], embedCount: 0 }
                ]);

            await plugin.startRun();
            expect(createdAnchors.length).toBe(2);

            await vi.advanceTimersByTimeAsync(65_000);
            await plugin.scan();
            expect(plugin.getState().total).toBe(2);

            await plugin.startRun();
            expect(createdAnchors.length).toBe(4);
            expect(plugin.getState().queued).toBe(2);
        });

        it("delays Blob URL revocation for 120 seconds (>= 60s)", async () => {
            mockDiscord.fetchWindow.mockResolvedValueOnce([
                { id: "m1", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 1, content: "hi", attachments: [], embedCount: 0 }
            ]);

            await plugin.exportFiles();
            expect(globalThis.URL.revokeObjectURL).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(60_000);
            expect(globalThis.URL.revokeObjectURL).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(60_000);
            expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledTimes(2);
        });

        it("handles nothing to delete in range", async () => {
            settingsStore.mode = "deleteOnly";
            mockDiscord.fetchWindow.mockResolvedValue([
                {
                    id: "msg1",
                    authorId: "222222222222222222", // other user
                    authorName: "Other",
                    timestamp: 1709640000000,
                    content: "other",
                    attachments: [],
                    embedCount: 0
                }
            ]);

            await plugin.startRun();
            expect(plugin.getState().note).toBe("Nothing to delete in this range.");
        });

        it("handles invalid context in startCore", async () => {
            settingsStore.fromDate = "bad-date";
            await plugin.startRun();
            expect(plugin.getState().phase).toBe("error");
        });
    });

    describe("P2 regressions: counters and the remembered backup offer", () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        const makeMessage = (id: string, timestamp: number) => ({
            id,
            authorId: "111111111111111111",
            authorName: "HajiLight",
            timestamp,
            content: id,
            attachments: [],
            embedCount: 0
        });

        it("does not resurrect a backup offer after a failed export (P2-7)", async () => {
            settingsStore.mode = "exportThenDelete";
            const message = makeMessage("m1", 1);
            mockDiscord.fetchWindow.mockResolvedValue([message]);

            // First Start: a backup is offered and the deletion is armed.
            await plugin.startRun();
            expect(createdAnchors.length).toBe(2);
            expect(plugin.getState().note).toContain("Backup offered");
            expect(plugin.getState().queued).toBe(1);

            // Lapse the 60 s confirmation window; the 10 min offer-reuse window is still open.
            await vi.advanceTimersByTimeAsync(65_000);

            // A manual export now fails while the save dialogs are opened.
            const origCreate = (globalThis as any).document.createElement;
            (globalThis as any).document.createElement = () => {
                throw new Error("Disk full");
            };
            // If the old offer were resurrected, the second press would reach this mock.
            mockDiscord.deleteMessage.mockResolvedValue({ outcome: "deleted", status: 204 });

            try {
                const exported = await plugin.exportFiles();
                expect(exported).toBe(false);
                const failedExport = plugin.getState();
                expect(failedExport.phase).toBe("ready");
                expect(failedExport.note).toContain("Export failed: Disk full");
                expect(failedExport.note).toContain("nothing will be deleted");
                expect(failedExport.queued).toBe(0);
                expect(failedExport.deleted).toBe(0);
                expect(failedExport.failed).toBe(0);
                expect(failedExport.forbidden).toBe(0);
                expect(failedExport.throttled).toBe(0);
                expect(createdAnchors.length).toBe(2);
                expect(mockDiscord.deleteMessage).not.toHaveBeenCalled();

                // Two Start presses while the dialogs still fail must neither reuse the stale
                // offer nor reach the deletion loop.
                await vi.advanceTimersByTimeAsync(2_000);
                await plugin.startRun();
                expect(plugin.getState().note).toContain("Export failed: Disk full");
                expect(plugin.getState().note).not.toContain("Backup offered");
                expect(plugin.getState().queued).toBe(0);

                await vi.advanceTimersByTimeAsync(2_000);
                await plugin.startRun();
                expect(plugin.getState().note).toContain("Export failed: Disk full");
                expect(plugin.getState().note).not.toContain("Backup offered");
                expect(plugin.getState().queued).toBe(0);
                expect(plugin.getState().deleted).toBe(0);
                expect(mockDiscord.deleteMessage).not.toHaveBeenCalled();
            } finally {
                (globalThis as any).document.createElement = origCreate;
            }

            // Once the dialogs work again, Start earns a fresh export; only then can a confirm delete.
            await vi.advanceTimersByTimeAsync(2_000);
            await plugin.startRun();
            expect(createdAnchors.length).toBe(4);
            expect(plugin.getState().note).toContain("Backup offered");
            expect(plugin.getState().queued).toBe(1);

            await vi.advanceTimersByTimeAsync(2_000);
            const deletePromise = plugin.startRun();
            await vi.runAllTimersAsync();
            await deletePromise;

            const st = plugin.getState();
            expect(st.phase).toBe("done");
            expect(st.deleted).toBe(1);
            expect(st.failed).toBe(0);
            expect(st.forbidden).toBe(0);
            expect(st.throttled).toBe(0);
            expect(mockDiscord.deleteMessage).toHaveBeenCalledTimes(1);
        });

        it("does not count a 429 that later succeeds as throttled (P2-2)", async () => {
            settingsStore.mode = "deleteOnly";
            settingsStore.verifyAfterRun = true;
            const message = makeMessage("m1", 1);
            mockDiscord.fetchWindow
                .mockResolvedValueOnce([message])
                .mockResolvedValueOnce([]);

            await plugin.scan();
            await plugin.startRun();
            await vi.advanceTimersByTimeAsync(2_000);

            mockDiscord.deleteMessage
                .mockResolvedValueOnce({ outcome: "rate_limited", status: 429, retryAfterMs: 500 })
                .mockResolvedValueOnce({ outcome: "deleted", status: 204 });

            const deletePromise = plugin.startRun();
            await vi.runAllTimersAsync();
            await deletePromise;

            const st = plugin.getState();
            expect(st.phase).toBe("done");
            expect(st.deleted).toBe(1);
            expect(st.failed).toBe(0);
            expect(st.throttled).toBe(0);
            expect(mockDiscord.deleteMessage).toHaveBeenCalledTimes(2);
            expect(st.note).toContain("Finished — 1 deleted, 0 already gone, 0 refused, 0 failed.");
            expect(st.note).not.toContain("throttled");
            expect(st.note).toContain("Verified: nothing of yours matching that range is left.");
        });

        it("counts a retried transport failure that answers 4xx as refused, not failed (P2-2)", async () => {
            settingsStore.mode = "deleteOnly";
            settingsStore.verifyAfterRun = true;
            const message = makeMessage("m1", 1);
            mockDiscord.fetchWindow
                .mockResolvedValueOnce([message])
                .mockResolvedValueOnce([message]);

            await plugin.scan();
            await plugin.startRun();
            await vi.advanceTimersByTimeAsync(2_000);

            mockDiscord.deleteMessage
                .mockResolvedValueOnce({ outcome: "failed" })
                .mockResolvedValueOnce({ outcome: "failed", status: 400 });

            const deletePromise = plugin.startRun();
            await vi.runAllTimersAsync();
            await deletePromise;

            const st = plugin.getState();
            expect(st.phase).toBe("done");
            expect(st.deleted).toBe(0);
            expect(st.forbidden).toBe(1);
            expect(st.failed).toBe(0);
            expect(st.throttled).toBe(0);
            expect(mockDiscord.deleteMessage).toHaveBeenCalledTimes(2);
            expect(st.note).toContain("Finished — 0 deleted, 0 already gone, 1 refused, 0 failed.");
            expect(st.note).toContain("1 answered with a 4xx (never retried)");
            expect(st.note).not.toContain("still failing after one retry");
        });

        it("counts a retry that stays rate-limited as throttled, not also failed (P2-2)", async () => {
            settingsStore.mode = "deleteOnly";
            settingsStore.verifyAfterRun = true;
            const message = makeMessage("m1", 1);
            mockDiscord.fetchWindow
                .mockResolvedValueOnce([message])
                .mockResolvedValueOnce([message]);

            await plugin.scan();
            await plugin.startRun();
            await vi.advanceTimersByTimeAsync(2_000);

            // Transport loss in the first pass, then every retry is a 429: one initial request
            // plus three retries inside the second pass.
            mockDiscord.deleteMessage
                .mockResolvedValueOnce({ outcome: "failed" })
                .mockResolvedValue({ outcome: "rate_limited", retryAfterMs: 1 });

            const deletePromise = plugin.startRun();
            await vi.runAllTimersAsync();
            await deletePromise;

            const st = plugin.getState();
            expect(st.phase).toBe("done");
            expect(st.deleted).toBe(0);
            expect(st.forbidden).toBe(0);
            expect(st.failed).toBe(0);
            expect(st.throttled).toBe(1);
            expect(mockDiscord.deleteMessage).toHaveBeenCalledTimes(5);
            expect(st.note).toContain("Finished — 0 deleted, 0 already gone, 0 refused, 0 failed, 1 throttled.");
            expect(st.note).toContain("1 still rate-limited after their retries");
            expect(st.note).not.toContain("still failing after one retry");
            expect(st.note).not.toContain("arrived during the run");
        });
    });

    describe("stopRun helper", () => {
        it("handles stop when idle", () => {
            plugin.stopRun();
            // does not change note when idle
        });

        it("handles stop when scanning", async () => {
            mockDiscord.fetchWindow.mockImplementation(async () => {
                plugin.stopRun();
                expect(plugin.getState().note).toContain("Stopping — finishing the page in flight");
                return [];
            });
            await plugin.scan();
        });
    });

    describe("Panel component", () => {
        it("renders the control panel component, notifies subscribers, and handles button clicks", async () => {
            mockDiscord.fetchWindow.mockImplementation(async (opts: any) => {
                opts.onProgress?.({ pages: 1, messages: 3, oldest: 1000 });
                return [
                    { id: "m1", authorId: "111111111111111111", authorName: "HajiLight", timestamp: 1, content: "hi", attachments: [], embedCount: 0 }
                ];
            });

            expect(hoistedHolder.pluginSettingsDef.panel).toBeDefined();
            effectCallbacks.length = 0;
            const comp = hoistedHolder.pluginSettingsDef.panel.component();
            expect(comp).toBeDefined();

            const cleanups = effectCallbacks.splice(0).map(fn => fn());

            // Click Preview button while subscribed so notify() runs listener
            const buttons = comp.props.children[1].props.children;
            buttons[0].props.onClick();
            await new Promise(resolve => setTimeout(resolve, 0));
            // Click Export button
            buttons[1].props.onClick();
            await new Promise(resolve => setTimeout(resolve, 0));
            // Click Start button (arms exportThenDelete)
            buttons[2].props.onClick();
            await new Promise(resolve => setTimeout(resolve, 0));
            // Re-render while armed — schedules expiry refresh timer
            vi.useFakeTimers();
            try {
                effectCallbacks.length = 0;
                const armedComp = hoistedHolder.pluginSettingsDef.panel.component();
                expect(armedComp.props.children[1].props.children[2].props.variant).toBe("dangerPrimary");
                expect(armedComp.props.children[1].props.children[2].props.children).toContain("Confirm delete (1)");

                const armedCleanups = effectCallbacks.splice(0).map(fn => fn());
                await vi.advanceTimersByTimeAsync(60_050);
                expect(mockSetState).toHaveBeenCalled();
                for (const cleanup of armedCleanups) if (typeof cleanup === "function") cleanup();
            } finally {
                vi.useRealTimers();
            }
            // Click Stop button
            buttons[3].props.onClick();

            for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();

            // Render in export-only mode (Start button omitted)
            settingsStore.mode = "export";
            const exportComp = hoistedHolder.pluginSettingsDef.panel.component();
            expect(exportComp.props.children[1].props.children[2]).toBe(false);
        });
    });

    describe("edge cases and error branches in index.tsx", () => {
        it("handles busy concurrency guard in scan, exportFiles, and startRun", async () => {
            let resolveFetch: any;
            const pending = new Promise(res => { resolveFetch = res; });
            mockDiscord.fetchWindow.mockReturnValueOnce(pending);

            const firstScan = plugin.scan();
            // Render Panel while scanning (working === true)
            const workingComp = hoistedHolder.pluginSettingsDef.panel.component();
            expect(workingComp.props.children[1].props.children[0].props.disabled).toBe(true);
            expect(workingComp.props.children[1].props.children[3].props.disabled).toBe(false);

            // While firstScan is in flight, busy === true
            const secondScan = await plugin.scan();
            expect(secondScan).toBe(false);

            const secondExport = await plugin.exportFiles();
            expect(secondExport).toBe(false);

            await plugin.startRun(); // should return early quietly

            resolveFetch([]);
            await firstScan;
        });

        it("stops scan cleanly when fetchWindow throws after cancellation", async () => {
            mockDiscord.fetchWindow.mockImplementationOnce(async () => {
                plugin.stop();
                throw new Error("Aborted fetch");
            });

            const ok = await plugin.scan();
            expect(ok).toBe(false);
            expect(plugin.getState().phase).toBe("stopped");
        });

        it("invalidates stale preview when exporting after target changes", async () => {
            mockDiscord.fetchWindow
                .mockResolvedValueOnce([
                    { id: "1", authorId: "111111111111111111", authorName: "A", timestamp: 1, content: "old", attachments: [], embedCount: 0 }
                ])
                .mockResolvedValueOnce([
                    { id: "2", authorId: "111111111111111111", authorName: "B", timestamp: 2, content: "new", attachments: [], embedCount: 0 }
                ]);

            await plugin.scan();
            settingsStore.target = "999999999999999999";
            mockDiscord.resolveTarget.mockReturnValue({
                channelId: "999999999999999999",
                kind: "dm",
                label: "Updated Chat"
            });

            const ok = await plugin.exportFiles();
            expect(ok).toBe(true);
            expect(mockDiscord.fetchWindow).toHaveBeenCalledTimes(2);
            expect(plugin.getState().note).toContain("Updated_Chat");
        });

        it("handles export failure when saveText throws", async () => {
            mockDiscord.fetchWindow.mockResolvedValueOnce([
                { id: "1", authorId: "111111111111111111", timestamp: 1, content: "x", attachments: [], embedCount: 0 }
            ]);

            const origCreate = (globalThis as any).document.createElement;
            (globalThis as any).document.createElement = () => {
                throw new Error("Disk write error");
            };

            const ok = await plugin.exportFiles();
            expect(ok).toBe(false);
            expect(plugin.getState().note).toContain("Export failed: Disk write error");
            (globalThis as any).document.createElement = origCreate;
        });

        it("handles startCore when selfId is empty initially or becomes empty after preview", async () => {
            mockDiscord.fetchWindow.mockResolvedValueOnce([
                { id: "1", authorId: "111111111111111111", timestamp: 1, content: "x", attachments: [], embedCount: 0 }
            ]);
            mockDiscord.selfId.mockReturnValue("");

            await plugin.startRun();
            expect(plugin.getState().phase).toBe("error");
            expect(plugin.getState().note).toContain("Discord has not finished loading your account");

            // Now scan succeeds with valid selfId, then selfId becomes empty before startRun
            mockDiscord.selfId.mockReturnValueOnce("111111111111111111");
            mockDiscord.fetchWindow.mockResolvedValueOnce([
                { id: "1", authorId: "111111111111111111", timestamp: 1, content: "x", attachments: [], embedCount: 0 }
            ]);
            await plugin.scan();
            mockDiscord.selfId.mockReturnValue("");
            await plugin.startRun();
            expect(plugin.getState().phase).toBe("error");
            expect(plugin.getState().note).toContain("Discord has not finished loading your account");
        });

        it("handles exportCore failure during exportThenDelete", async () => {
            mockDiscord.fetchWindow.mockResolvedValueOnce([
                { id: "1", authorId: "111111111111111111", timestamp: 1, content: "x", attachments: [], embedCount: 0 }
            ]);

            const origCreate = (globalThis as any).document.createElement;
            (globalThis as any).document.createElement = () => {
                throw new Error("Disk full");
            };

            await plugin.startRun();
            expect(plugin.getState().note).toContain("Export failed: Disk full");
            (globalThis as any).document.createElement = origCreate;
        });

        it("handles unexpected throw during runDeletion", async () => {
            vi.useFakeTimers();
            try {
                settingsStore.mode = "deleteOnly";
                mockDiscord.fetchWindow.mockResolvedValue([
                    { id: "1", authorId: "111111111111111111", timestamp: 1, content: "x", attachments: [], embedCount: 0 }
                ]);

                await plugin.startRun();
                await vi.advanceTimersByTimeAsync(2000);

                mockDiscord.deleteMessage.mockImplementationOnce(() => {
                    throw new Error("Fatal deletion crash");
                });

                const deletePromise = plugin.startRun();
                await vi.runAllTimersAsync();
                await deletePromise;

                expect(plugin.getState().phase).toBe("error");
                expect(plugin.getState().note).toContain("Run stopped by an error: Fatal deletion crash");
            } finally {
                vi.useRealTimers();
            }
        });
    });
});
