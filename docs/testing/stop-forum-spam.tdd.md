# Account reputation TDD evidence

Journeys were derived from the request to raise caution for identifiers listed by Stop Forum Spam. The accepted behavior is advisory T3 only, explicit external-lookup opt-in, human authority first, privacy-minimized evidence, and both standalone SQLite and distributed PostgreSQL support.

## RED / GREEN

| Guarantee | RED evidence | GREEN evidence |
|---|---|---|
| Strict optional policy and configuration | `reputation-policy.js` was missing; SFS configuration was undefined | Validated immutable T3-only policy; invalid tiers and settings rejected |
| Private read-only provider client | New client module missing | Hashed email, eligible IPs only, fixed HTTPS endpoint, sanitized errors and bounded responses |
| Provider quota and shared cache | SQLite 22 passed / 3 failed for missing reputation APIs | SQLite 26 passed, plus PostgreSQL shared-state and migration checks |
| Unmatched-note intake | Envelope target: 3 passed / 1 failed because ordinary notes produced no candidate | Explicit schema-v2 candidate with IDs only; forged verdict fields rejected |
| Durable advisory workflow | Integration target: 0 passed / 3 failed because workers rejected reputation candidates | T3-only review, no Misskey mutation, cache dedupe, unavailable results and human overrides pass |
| Fresh account state | Reputation target: 9 passed / 1 failed; a simulated hour-long IP wait still produced a listed verdict | Stale snapshots are unavailable before external disclosure |
| Bounded body timeout and provider cooldown | New 503/stalled-body regressions failed before correction | 14 provider tests pass; 429/503 cooldown ignores undocumented response bodies, stalled reads abort |

Current-branch checkpoints retain the failing specifications: `a55e6ae`, `962fce3`, `125b5d0`, `db07b3d`. Implementations are recorded in `ddf0eef`, `0fb8f06` and `698fdca`; history was not rewritten.

## Acceptance verification

- `bun test --coverage` with the isolated PostgreSQL test URL: **190 passed, 0 failed across 24 files**. The all-files report, including test files, was 90.40% functions / 89.17% lines. Runtime used for this task: Bun 1.4.4.
- Targeted checks cover static T1 bypass, static T2 during SFS outage, opt-in application startup with a real durable worker, protected accounts, human intervention during reads, old-schema extension and stale leases.
- The PostgreSQL-specific SFS test uses independent connections to verify one shared quota grant under concurrent requests, cache visibility, separate Misskey allowance, cooldown and fenced writes.
- `bun run build` passed, including generated-policy validation and both service/maintenance bundles.
- Bundled `dist/cli.js migrate` ran twice against PostgreSQL with stable inbox, review, audit, human and action state. One SFS cache record, daily usage and an active provider cooldown were preserved; the export footer verified. The task-owned database fixture was stopped afterward.
- `git diff --check` passed. Changes are SSH-signed local commits; no remote push.

## External verification and limits

The official [SFS API documentation](https://www.stopforumspam.com/usage) was retrieved using a public CLI HTTP request after the browsing tool returned 403. A synthetic reserved `example.invalid` mailbox was normalized and hashed locally; the official HTTPS API returned HTTP 200 and a valid negative `emailhash` JSON response. The final Bun `StopForumSpamClient` also performed this lookup with its real bounded parser and an in-memory quota store, returning `appears:false, frequency:0`. No real user identifiers or tokens were submitted for verification.

The official Misskey implementations were checked for [email access](https://github.com/misskey-dev/misskey/blob/develop/packages/backend/src/server/api/endpoints/admin/show-user.ts) and the [administrator-only IP history API](https://github.com/misskey-dev/misskey/blob/develop/packages/backend/src/server/api/endpoints/admin/get-user-ips.ts). Compatibility with a live deployed Misskey server, actual listed accounts and production throughput remains unverified. Positive, failure and concurrency behavior uses controlled fixtures. The existing LLM review and historical purge workers remain unwired.
