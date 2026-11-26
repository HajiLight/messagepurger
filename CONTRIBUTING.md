# Contributing

## Setup

```bash
git clone https://github.com/Vendicated/Vencord.git
cd Vencord
pnpm install --frozen-lockfile
git clone https://github.com/HajiLight/messagepurger.git src/userplugins/messagePurger
pnpm build        # or: cd src/userplugins/messagePurger && node scripts/dev.mjs --build
pnpm check        # typecheck + vitest
```

Node.js 22+ and pnpm are required. `dev.mjs` can also use `$VENCORD_DIR`, `./.vencord`, `../Vencord`, or `../vencord/Vencord` if you keep the checkout elsewhere.

## Layout

| File | Responsibility |
| --- | --- |
| [`core.ts`](core.ts) | Pure logic only (no Vencord, network, or DOM imports) |
| [`discord.ts`](discord.ts) | Discord `RestAPI` and Store adapters |
| [`index.tsx`](index.tsx) | Plugin settings, UI panel, and run orchestration |
| [`tests/`](tests) | Vitest suites covering `core.ts`, `discord.ts`, and `index.tsx` |

## Safety & code rules

- Any destructive path must have a matching preview path, manual start, and explicit count confirmation.
- Keep deletion rules narrow: author, the measured call-record exception (message type `3` or a call marker, reported but never queued), and `excludePinned`. Do not add a blanket message-type allowlist; other message types are attempted. `429` is retried; other `4xx` are final.
- Transport/5xx failures may retry once at the end of a run; `429` waits for `retry_after` + margin (max 3 retries), and `captcha_key` or 3× consecutive `401`/`403` abort immediately.
- Explain how Discord API changes were verified (unit tests or live client checks).

## Commits & License

- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`) and ensure `pnpm check` passes.
- Contributions are licensed under [GPL-3.0-or-later](LICENSE), matching Vencord.
