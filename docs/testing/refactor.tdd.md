# Service refactor evidence

## Source and intended behavior

This refactor follows `AGENTS.md`. The service separates application lifecycle, bounded incoming processing, case orchestration, Misskey enforcement, human authority, and durable persistence. Deterministic policy, tier selection, dry-run defaults, event/job formats, and the disconnected LLM/purge workers retain their existing behavior.

Operator guarantees:

1. Accepted notes process serially; active and waiting notes share a bounded capacity.
2. Overflow and processing failures are observable without recording note content.
3. Shutdown and streaming failure drain accepted work and close application resources.
4. Protected accounts and newly appearing human overrides stop enforcement or purge scheduling.
5. Audit and queue indexes update only after successful persistence, retaining retry and deduplication behavior.

## RED / GREEN evidence

| Area | Command | RED evidence | GREEN evidence |
|---|---|---|---|
| Existing behavior baseline | `bun test test/moderation.test.js test/persistence.test.js test/misskey.test.js test/config.test.js` | N/A | 21 passed before implementation |
| Incoming processor and application | `bun test test/note-processor.test.js test/application.test.js test/config.test.js` | 2 passed, 4 failed, 2 errors: processor/application modules were missing and capacity was undefined | 13 passed after implementing the components and capacity configuration |
| Enforcement boundary | `bun test ./test/enforcement.test.js ./test/persistence.test.js` | Enforcer module was missing; 7 existing/characterization persistence tests passed | `bun test ./test/enforcement.test.js ./test/moderation.test.js ./test/persistence.test.js`: 23 passed |
| Protected role shapes | `bun test ./test/enforcement.test.js ./test/moderation.test.js ./test/persistence.test.js` | 22 passed, 1 failed: nested administrator/moderator roles were not protected | 23 passed after checking nested role flags |
| Health startup | `bun test test/health.test.js -t 'reports startup failures'` | 1 failed: startup returned a server rather than an awaitable result | `bun test test/health.test.js test/application.test.js`: 7 passed; final startup-failure test uses an occupied local port |

No commits were created: the project forbids commits, and this directory has no Git metadata.

## Final verification

- `bun test --coverage test/application.test.js test/classification.test.js test/config.test.js test/enforcement.test.js test/health.test.js test/matcher.test.js test/misskey.test.js test/moderation.test.js test/note-processor.test.js test/persistence.test.js`: 50 passed, 0 failed, 188 assertions. Bun's aggregate coverage was 90.11% functions and 93.34% lines (the reported aggregate includes test files). Classification, configuration, health, and incoming processor lines were fully covered; application lines were 98.95% covered.
- `bun run build`: 4 generated-rule checks passed and 16 modules bundled to `dist/index.js` (31.73 KB).
- An independent review and a focused follow-up review of nested protected roles and retry semantics found no actionable issues.
- The unchanged LLM validation module was outside the selected test run. Process signal handling and actual Misskey streaming/reconnection were not exercised end to end. Existing logger and stream branches remain partially covered.

## Test specification

| Guarantee | Test target | Type |
|---|---|---|
| Active work counts against capacity; close drains notes in order; failures do not block later notes | `test/note-processor.test.js` | Unit |
| Account and T2-role validation precede startup; stream failure and construction failure close resources | `test/application.test.js` | Service |
| Binding failures reject startup; health reports connection status and processing counters | `test/health.test.js` | Local HTTP integration |
| Suspension and audit precede purge; fresh human authority and protected-user state suppress actions | `test/enforcement.test.js` | Service/security |
| Tier-specific actions, dry-run, completion and failed-action retry remain intact | `test/moderation.test.js` | Service/security |
| Completed cases survive restart; failed appends remain retryable; pending jobs deduplicate and consume capacity | `test/persistence.test.js` | Persistence integration |
| Dry-run and bounded capacity configuration are validated | `test/config.test.js` | Unit |

## Verification limits

Misskey API behavior has not been exercised against a live server. Unit/service tests use injected API dependencies, and HTTP tests use only transient local health servers that close in `finally` blocks. LLM review and historical deletion remain persisted queues without connected workers. Incoming overflow is rejected and logged; streaming does not backfill those notes.
