# Short process-manager commands

Acceptance: keep `pnpm start` as foreground execution; provide short optional PM2 commands for background start, status, logs, restart and stop; preserve Node/Bun operation and graceful shutdown on Windows without OS-specific shell commands.

## RED / GREEN

- `f3836a0` records the missing shutdown module and process-manager safety specifications (RED).
- `pnpm exec vitest run test/process-management.test.js test/application.test.js`: **12 passed**. Native Bun for the same targets: **12 passed**.
- Tests cover SIGINT/SIGTERM, the exact PM2 `shutdown` IPC message, ignoring unrelated messages, removing only owned listeners, one forked instance, no forced duplicate process, disabled watching, a 30-second cleanup budget, absolute application paths and no embedded credentials/enforce default.
- Targeted V8 coverage for `src/shutdown.js`: **100% statements, branches, functions and lines**.
- Both `bun run build:bun` and `pnpm run build` passed after the change.

## Integration verification

PM2 7.1.2 was installed locally as an operational development tool. A private test home and unique Windows named pipes isolated the test daemon from any existing PM2 instance. This was necessary because this PM2 version uses shared default named-pipe names on Windows even when `PM2_HOME` changes; only the ignored verification harness overrides those names. The shipped configuration uses standard PM2 behavior.

Using the real `pnpm daemon:*` shortcuts, both Node.js 24.18.0 and Bun 1.4.4 passed background start, a second start without duplicate instances, status, restart with a new PID, normal stop and removal. The app authenticated to a controlled local HTTP API, connected through a real WebSocket and reached a healthy worker/storage/stream state. Each stop exited with code 0 before the forced-kill timeout. The private app and daemon were stopped afterward; existing PM2 pipes/apps were not touched. No live Misskey credentials or user data were used.

The configuration is platform-neutral; the actual process-manager smoke ran on Windows. Linux/macOS PM2 startup registration, OS reboot persistence, systemd installation and live Misskey remain unverified. Those steps are explicitly separate from ordinary background start in the guide. Database drivers and moderation behavior were unchanged, so the unrelated full suite was not rerun.

Contracts checked against the official [Misskey foreground/systemd guide](https://misskey-hub.net/ja/docs/for-admin/install/guides/manual/), [PM2 ecosystem configuration](https://pm2.keymetrics.io/docs/usage/application-declaration/), [graceful shutdown](https://pm2.keymetrics.io/docs/usage/signals-clean-restart/) and [OS startup registration](https://pm2.keymetrics.io/docs/usage/startup/).
