# Misskey Automod TDD evidence

## Source and journeys

The implementation follows the project `AGENTS.md` and these operator journeys:

1. A human writes moderation intent in `rules.md`; this conversation produces a fixed `rules.generated.json` artifact.
2. Runtime classification selects the strongest matching tier in the order T1, T2, T3 without calling an LLM.
3. T1 suspends a non-moderator account and persists a server-side purge job; T2 assigns a restrictive role; T3 performs no Misskey mutation.
4. T2 and T3 persist delayed LLM-review jobs whose eventual output cannot select T1.
5. A human decision suppresses deterministic mutation and LLM review, and protected moderator accounts are never changed automatically.
6. Audit and job state survive restarts; transient write/API failures remain visible and retryable.

## RED / GREEN report

| Stage | Command | RED evidence | GREEN evidence |
|---|---|---|---|
| Tier architecture | `bun test test/classification.test.js test/llm-review.test.js test/moderation.test.js test/generated-rules.test.js` | 1 pass, 6 fail, 3 errors because tier modules and schema v2 did not exist | New classifier, typed LLM result boundary, tiered engine, and schema v2 implemented |
| Persistence retry safety | `bun test test/persistence.test.js` | 2 pass, 2 fail because failed jobs were treated as known and case IDs were ignored | 4 pass after pending-job dedupe, retry recovery, and case-level human overrides |
| Completion semantics | `bun test test/persistence.test.js test/moderation.test.js` | 9 pass, 2 fail because classification was incorrectly treated as completion | 11 pass after adding explicit `case.completed` state and failed-action retry |
| Queue capacity | `bun test test/persistence.test.js test/config.test.js` | 6 pass, 2 fail because the queue and configuration had no upper bound | 8 pass after adding `MAX_QUEUED_JOBS` and fail-closed capacity handling |
| Final suite | `bun test --coverage` | N/A | 36 pass, 0 fail, 88 assertions |

No Git checkpoint commits were created because this directory is not a Git repository and the operator retains commit control.

## Test specification

| # | Guarantee | Test file | Type | Result |
|---|---|---|---|---|
| 1 | Generated schema v2 matches the normalized SHA-256 of `rules.md` and rejects unsafe rules | `test/generated-rules.test.js` | Integration/security | PASS |
| 2 | Multiple matches select T1 over T2 over T3 | `test/classification.test.js` | Unit | PASS |
| 3 | LLM results are typed, tied to terms evidence, and cannot select T1 | `test/llm-review.test.js` | Unit/security | PASS |
| 4 | Text, CW, file metadata, polls, and usernames match while remote/self/excluded users are skipped | `test/matcher.test.js` | Unit | PASS |
| 5 | T1/T2/T3 actions, moderator protection, human priority, dry-run, and retry behavior are enforced | `test/moderation.test.js` | Service/security | PASS |
| 6 | Misskey requests authenticate without leaking tokens and use the intended admin endpoints | `test/misskey.test.js` | Integration | PASS |
| 7 | Completed cases and job spools survive restarts; concurrent jobs deduplicate; invalid human state fails closed | `test/persistence.test.js` | Integration/reliability | PASS |

## Final verification

- `bun test --coverage`: 36 passed, 0 failed; 94.75% functions and 94.25% lines overall.
- `bun run build`: generated-rule check passed and 12 modules bundled to a 27.79 KB `dist/index.js`.
- Runtime secret review: no access token or full note text is written to the durable ledger or application log.
- The generated policy currently has no active rules, so deployment has no moderation effect until the operator supplies real policy entries.
- Docker Compose runtime validation was not performed on this host if the Docker CLI is unavailable.

## Deliberate boundaries

- The LLM review worker remains disconnected until its provider/model and the server terms-of-service document are supplied.
- The T1 purge worker remains disconnected because the public `users/notes` endpoint cannot enumerate every followers-only or direct note, even for a moderator. A Misskey-side administrative capability is required to promise full historical deletion.
- `localTimeline` does not backfill downtime and does not expose all visibility levels. Complete inspection requires a Misskey server-side event hook.
