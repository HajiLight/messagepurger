# Security policy

## Scope

`MessagePurger` is a local Vencord userplugin operating solely inside your own Discord client via `RestAPI`. It has no server, no telemetry, no token handling, and sends nothing outside Discord. Issues in Discord or Vencord themselves are out of scope.

## Reporting a vulnerability

Use **Security → Report a vulnerability** (private advisory). If that is unavailable, open an issue **without message content**, and include:

- Plugin version (`package.json`), Discord `GLOBAL_ENV.BUILD_NUMBER`, and Vencord commit
- Exact panel note (redact any private display name), whether a backup existed, and reproduction steps

## In scope vs. out of scope

**In scope:**
- Any path deleting a message not authored by the active account
- Any path deleting without a matching two-step confirmation of the shown run
- Any path deleting after a failed export (noting the renderer cannot observe OS Save dialogs)
- Any network request leaving the machine other than Discord's API via the client

**Out of scope:**
- Findings requiring hand-edited `settings.json` values where the plugin clamps or falls back (label as hardening suggestions)
- Known limitations documented in [`README.md`](README.md)
- Rate limits or account/IP bans from lowering delays or bulk self-botting

## Supported versions

1.x — the latest [release](https://github.com/HajiLight/vencord-message-purger/releases) and the latest commit on `main`. Older releases do not receive fixes.
