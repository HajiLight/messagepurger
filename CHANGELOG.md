# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.1] — 2026-11-26

### Fixed

- Voice and video call records (Discord message type `3`) are now skipped instead of attempted and
  are reported separately. They are not counted as deletable leftovers by the after-run
  verification, which names them explicitly when they remain in the range.

## [1.0.0] — 2026-11-25

First public release. Tested with Discord Stable `1.0.9269` and Vencord `1.15.19`.

### Added

- Delete your own messages in 1:1 DMs and server text channels, targeted by user ID or channel ID.
- Date-range, case-insensitive text and attachment (`any` / `only` / `without`) filters, with a
  preview that reports the exact number of matching messages before anything is deleted.
- Three modes: **Export, then delete** (default), **Export only** and **Delete only**.
- Backup export of every message that matches the filters from both authors, as JSONL (one
  structured message per line) and TXT (human-readable log); backups are never capped by the run
  cap. It is a preview-time snapshot: messages arriving or edited after the preview are not in it.
- Per-run delete cap: 300 by default, with 1 000, 3 000 and no-cap options.
- `excludePinned` setting to leave pinned messages in place (default off; pin state is read at
  preview time, so a pin added afterwards is still deleted), and `verifyAfterRun` to re-read the
  range after a run and report what is left (default on).
- `Stop` cancels active pacing waits, history paging and verification.

### Safety

- Two-step confirmation: the first `Start` arms and prints the exact delete count, the second
  confirms. The confirmation is stamped to the chat, cap, mode, range and `excludePinned`, and
  expires after 60 seconds.
- Only messages authored by you are deleted; other authors appear in the backup only.
- Captcha challenges (HTTP `400` with `captcha_key`) abort the run immediately, as do three
  consecutive `401`/`403` responses.
- Conservative pacing: 1.4 s base delay with ±40% jitter, 6–18 s pauses every 15–30 deletions,
  600–1 200 ms between history pages, and `429` retries using `retry_after` (up to 3).
- Calendar-validated date ranges; unparseable timestamps never pass the filters, and a missing
  HTTP status counts as a failure, never a deletion.
- Group DMs and threads are refused explicitly rather than partially supported.

### Notes

- Deletions are permanent and visible to everyone in the chat.
- Backup files contain attachment names and URLs, but not attachment bytes; Discord CDN links
  expire.
- Automating message deletion on a user account is treated as automation/self-botting under
  Discord's Terms of Service and can result in account suspension or IP bans. The built-in
  safeguards reduce accidental bursts but cannot guarantee an account will not be flagged.
