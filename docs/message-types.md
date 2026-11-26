# Discord call records — measured 2026-11-26

The deletion layer has one measured, intentional exception: **call records are never queued for
deletion**. This note records the observation so the rule is not mistaken for an assumption.

## Environment

- Discord Stable (`1.0.9269` as recorded in the README) and Discord Canary, Vencord `1.15.19`.
- One-to-one DM between two accounts; the call was started from one account and joined from the
  other.

## Observation

A finished voice call and a finished video call each produced **one message** with:

| Field | Value |
| --- | --- |
| `type` | `3` |
| `content` | empty |
| `call` | present, with `participants` and `ended_timestamp` |
| `author` | the account that started the call |

The two calls produced two records with the same shape; video vs voice did not change the type.

A separate DM held **8 already-existing call records** authored by the main account. A read-only
scan of that DM returned:

- `9011` messages in the range,
- `8` messages authored by the main account — all `type: 3`,
- `0` other messages authored by the main account,
- queue length `0`,
- panel note: `8 call messages among yours are skipped — not in the delete count.`

No `DELETE` request was sent for any call record. The plugin skips the record before it builds the
delete queue (see `isCallMessage()` in `core.ts`).

## Scope of this measurement

Tested for 1:1 DM voice and video calls. Group DMs and threads are refused by the target resolver
and were not part of this test. A call record that Discord stores with a missing `type` is still
recognised by the `hasCall` marker mapped from the `call` object.
