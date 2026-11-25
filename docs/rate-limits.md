# Discord rate limits & pacing

MessagePurger's pacing in [`core.ts`](../core.ts) and [`discord.ts`](../discord.ts) is built around Discord's rate-limit model rather than throughput:

## Why pacing is conservative

- **Dynamic, hidden buckets:** Discord does not publish static per-endpoint limits, and the desktop client strips `X-RateLimit-*` headers from `RestAPI` responses. Because the client cannot adapt to the active bucket at runtime, it targets the slowest documented delete bucket.
- **Global & invalid-request ceilings:** Discord enforces a **50 req/s** global limit per user and Cloudflare imposes a **temporary IP ban at 10,000 invalid requests (`401`, `403`, `429`) within 10 minutes**.
- **No bursts:** Bursting risks hitting the shared slow bucket and burning the invalid-request budget. The sustained average stays below 1/s, but individual intervals can exceed it (1,400 ms ±40% reaches 840 ms ≈ 1.19/s); the periodic pauses keep the run as a whole under the ceiling.

## Observed `DELETE /channels/{id}/messages/{id}` buckets

| Bucket | Condition | Limit |
| --- | --- | --- |
| `9a4e05a2…` | Message < 10 s old | 5 / 1 s |
| `c51d12ac…` | Message > 10 s old | 3 / 0.33 s (~9 / s) |
| `b5e35274…` | Message > 2 weeks old | 30 / 4 s (7.5 / s) |
| `80c17d2f…` | Shared with send/edit (`POST`/`PATCH`) | **5 / 5 s (1 / s)** |

## How the plugin handles limits & errors

- **Baseline rhythm:** 1,400 ms base delay with ±40% jitter (840–1,960 ms) plus a 6–18 s pause every 15–30 deletions (~0.5 req/s sustained), and 600–1,200 ms between history pages.
- **`429` handling:** Waits for `retry_after` (plus 1–3 s margin), increases base delay 1.2× (capped at 4 s), and retries the same message or page up to 3 times.
- **End-of-run transport retries:** Network failures (`status 0` / no status / `5xx`) are retried once at the end. `429` is retried up to 3×; all other `4xx` are final (`403` refused, `404` already gone).
- **Safety aborts:** Three consecutive `401`/`403` responses trigger a circuit-breaker abort; any HTTP `400` carrying `captcha_key` aborts immediately.

## Sources

- [Discord Rate Limits](https://docs.discord.com/developers/topics/rate-limits)
- [Discord Message Resource](https://docs.discord.com/developers/resources/message) (`bulk-delete` is guild-only with `MANAGE_MESSAGES`)
- [`discord-api-docs#8330`](https://github.com/discord/discord-api-docs/issues/8330) · [`discord-api-docs#2132`](https://github.com/discord/discord-api-docs/issues/2132)
