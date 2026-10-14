# Durable processing TDD evidence

This change adds a persistent, privacy-minimized intake queue while retaining the existing deterministic severity/authority contract and the dry-run default. SQLite remains the standalone default; PostgreSQL provides shared inbox, user leases, completion, journals, human decisions and API budget.

## RED / GREEN checkpoints

| Area | RED evidence | GREEN evidence |
|---|---|---|
| Storage | `bun test test/storage.test.js test/storage-postgres.test.js`: missing storage module; two import errors | Real SQLite persistence/reopen/capacity/leases and PostgreSQL cross-connection tests |
| API budget and journal | 6 pass, 6 fail, 2 missing module/export errors before production | 30 initial targeted tests passed; later preflight regression tests added |
| Inbox/intake/worker | 4 pass, 4 fail, 3 missing-module errors | 18 config/envelope/intake/worker tests passed |
| Application integration | 11 pass, 7 fail before integration | Standalone admission/drain, ingest-only, worker-only, failures and persisted-case processing pass |
| Legacy import | Missing-module RED | Streaming import, validation, privacy, fingerprints, legacy username and human-decision idempotency pass |
| API review fixes | 15 pass, 2 fail for premature journal start / stale user state | Post-budget preflight, freshness and definite-no-send reset regressions pass |
| Migration safety | Three failing regressions for footer integrity, import markers and source namespace | Digest-verified interrupted import, current source existence and legacy/human indexes verified |
| Existing SQLite source | Bundled CLI smoke failed because Bun's `create:false` open omitted the writable flag; positive reopen regression reproduced it | Explicit `readwrite:true`, positive reopen and missing-path non-creation assertions pass; bundled migration succeeds twice |

Checkpoint commits preserve the initial failing specifications; subsequent feature commits implement the contracts. An independent review identified journal timing, stale state, legacy username, human-decision projection and regenerated-export resume issues; each was addressed with targeted verification.

## Integration coverage

- Body-free envelopes are the only inbox payload; private note text/tokens never enter exported state.
- Duplicate deliveries and restarted workers do not repeat completed role assignment.
- Shared human decisions block mutations and delayed-review admission.
- Stale lease holders cannot append audit, queue jobs or mutate Misskey.
- An ambiguous started suspension produces human-review audit without retrying suspension or enqueueing purge.
- Pending/dead/retry/heartbeat behavior, queue caps, per-user exclusion and persisted completion survive storage restart.
- Offline migration retains authority, tombstones, jobs, actions and API cooldown, refuses mixed/incomplete/altered imports, and supports regeneration after elapsed time.
- Bundled service and maintenance CLI build with Bun 1.3.14. Bundled `status` and `override` smoke checks use an isolated SQLite database without a Misskey connection.
- Distributed Compose YAML is parsed using Bun's YAML parser; no Docker daemon or network stack changes are required for the check.

## Final verification

- `bun test --coverage` with `AUTOMOD_TEST_DATABASE_URL`: **154 passed, 0 failed**, 642 assertions across 21 files. Bun's all-files report (including test files) was 92.29% functions / 94.74% lines.
- Storage-specific checks: SQLite **22/22**, PostgreSQL **5/5**, including shared-schema initialization, concurrent claims and interrupted migration.
- The final one-line change put the export clock read inside the normal bounded database transaction. SQLite **22/22** passed afterward; the final bundled migration smoke also exercises PostgreSQL export.
- The subsequent existing-source open correction passed SQLite **22/22** (148 assertions). The final rebuilt `dist/cli.js migrate` ran twice against PostgreSQL with unchanged target state: one pending case, one completed case and one review job. Completed-ID dedupe, human indexes, both journal states and the PostgreSQL export footer verified. The task-owned PostgreSQL fixture was then stopped.
- `bun run build`: both `dist/index.js` and `dist/cli.js` produced successfully; generated-policy checks passed.
- `git diff --check` passed. Changes are grouped into SSH-signed local commits; no push is performed.

## Verification limits

Live Misskey behavior and production throughput have not been verified. PostgreSQL integration uses a temporary local PostgreSQL 18.6 fixture; it does not validate deployment infrastructure, HA, TLS or production credentials. Docker/systemd examples are configuration artifacts, not deployments performed by this task. LLM review and historical purge workers remain unwired. Streaming delivery is durable only after database commit and has no acknowledgment/backfill guarantee.
