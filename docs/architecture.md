# Moderation architecture

## Decision flow

```text
Misskey localTimeline
  -> deterministic classifier (no LLM, no network)
  -> body-free versioned envelope
  -> durable inbox (SQLite / PostgreSQL)
  -> leased worker, one active case per user
     -> current human decision / protected-user gate
     -> T1: journal + suspend + persistent purge job
     -> T2: journal + restrictive role + delayed review job
     -> T3: delayed review job
  -> durable completion index + inbox tombstone
```

Small installations use built-in `bun:sqlite`, WAL/FULL synchronization, a local database and one `all` process. Distributed installations use Bun's built-in PostgreSQL client, a dedicated Automod database, `ingest` producers and multiple `worker` processes. No Misskey database access or Redis is required. [Deployment and migration instructions](deployment.md) describe both configurations.

## Component responsibilities

| Module | Responsibility |
|---|---|
| `index.js`, `application.js` | Configuration, authentication, composition, process lifecycle |
| `classification.js`, `matcher.js` | Static policy evaluation |
| `inbox-envelope.js`, `durable-intake.js` | Exact schema validation, policy/mode binding, body-free durable admission |
| `durable-worker.js` | Bounded concurrency, lease renewal/cancellation, retries and dead letters |
| `storage/index.js` | Atomic inbox claims, user leases, audit, completion, jobs, human decisions, journal and API budget |
| `moderation.js`, `enforcement.js` | Case transitions, authority gates and guarded Misskey mutations |
| `shared-authority.js`, `human-authority.js` | Shared decisions and SQLite's local fail-closed override file |
| `rate-limiter.js`, `misskey.js` | Shared API admission, cooldown, timeouts and sanitized errors |
| `legacy-import.js`, `maintenance.js`, `cli.js` | Validated streaming legacy import, overrides, offline state migration and status |

`note-processor.js` and `persistence.js` retain the previous interfaces for callers; the application no longer uses their memory-only inbox or JSONL writers.

## Durable processing guarantees

An intake submission succeeds after its database transaction commits. It contains only local user/note/case IDs, tier, rule IDs/reasons, schema version, policy hash and execution mode. Raw note bodies, CW, attachments, profiles and access tokens do not enter the inbox. Non-matches are discarded after classification. Reprocessing uses the saved classification and rejects malformed or incompatible policy/mode envelopes.

Unique `(namespace,note_id)` inbox keys survive completion. Completion removes the payload but retains its tombstone. Active capacity counts pending/running/dead cases; review and purge capacity are independently bounded. Audit and tombstone retention are intentionally not silently truncated; operators must manage total storage capacity.

PostgreSQL uses transactional row locks, `SKIP LOCKED`, a unique user-lease row and database time. SQLite serializes write transactions. Claims carry random fencing tokens; audit, journal, job insertion, failure and completion all check the current token and lease. Heartbeats extend both inbox and user leases; a failed renewal aborts API waits/requests. Expired work becomes pending or dead after its attempt limit. Completed case indexing never acknowledges an inbox claim by itself, so a crash between case completion and acknowledgment remains recoverable.

A per-case action journal records `started` before sending a mutation and `completed` after a definite successful response. A restarted worker never blindly repeats an uncertain `started` mutation: it records `automation.skipped.uncertain` and leaves suspension/purge to a human. A completed journal is reconciled with current Misskey state before continuing. A reversed state is treated as human-managed. A preexisting suspension without this case's completed journal never authorizes historical deletion. Definite 429 rejection may reset the start marker and retry through the shared cooldown.

HTTP cannot be atomically committed with this database. Cancellation/fencing prevents new operations after a detected lease loss, but cannot retract a request already accepted by Misskey. Fully atomic precedence against concurrent Misskey control-panel actions requires a Misskey-side conditional administrative boundary. Do not claim exactly-once remote mutations.

## API budget and authority

All calls, including authentication and account reads, acquire the same namespace's database budget. Admission uses the database clock on PostgreSQL. Processes wait without reserving a growing future queue. A 429 extends a shared cooldown using bounded `Retry-After`; workers and ingesters observe it. Request timeouts, abort signals, bounded retry counts and dead-letter metrics expose failure instead of hiding unbounded retries. Never vary namespace or API interval to bypass server limits.

Mutation preflight rejects an aged Misskey snapshot after a long budget wait, before starting its action journal. Freshness allows the configured normal API interval plus a small guard-latency allowance. The next attempt reads fresh state after cooldown. A preflight failure clears its start marker only while its lease remains valid. There remains a read/mutate race with the unconditional upstream API; explicit shared overrides and a future conditional server boundary are required for stronger guarantees.

Priority remains: human decision, existing human-managed/protected Misskey state, deterministic policy, delayed LLM recommendation. Shared human decisions are recorded with actor/timestamp/reason and checked immediately before each mutation, after API budget waits. SQLite additionally reloads its local file each time. Invalid local files fail closed. Use `bun run override` for PostgreSQL; local files on different machines are not a shared authority. A Misskey control-panel event bridge is not yet implemented.

Moderator and administrator flags, including flags in role objects, prevent automatic enforcement. T1 requires suspension before a purge job; a human decision at the purge boundary stops enqueueing. Idempotent job keys and persisted completion/journal state survive restarts and backend migration.

## Lifecycle and monitoring

`all` runs intake and workers; `ingest` only admits notes; `worker` never opens a streaming socket. Health binding and DB startup must succeed before streaming. Shutdown stops acceptance, closes streaming, cancels workers and waits for in-flight database writes/renewals before closing storage. Interrupted work retains its lease until expiration and recovery.

Health is role-aware and reports storage, required stream and worker status, inbox/job counts, oldest pending time, API budget/cooldown, intake counters and worker counters. A healthy process does not imply the queue is caught up; monitor backlog age, dead letters, capacity and failure counters separately.

Legacy JSONL import validates and streams records with per-line idempotency and unchanged-file markers. Offline SQLite-to-PostgreSQL migration preserves decisions, completion/tombstones, pending work, journal, jobs, audit and cooldown. The destination rejects ordinary operations until import completion and rejects mixing with existing state. Stop every producer/worker during migration and retain the same namespace.

Migration records retain absolute persisted deadlines so a new export of an unchanged source has the same digest after interruption. Synchronize source/destination clocks. Stable record digests and a count/digest footer reject altered, missing or mixed records; imported legacy markers prevent source replay from duplicating audit or human decisions.

## Unwired boundaries

LLM review remains queued only; no provider/model or server terms document has been selected. Its output envelope accepts only `clear`, `T2`, `T3`, `human-review` and rejects T1. The runtime remains useful without an LLM.

Historical purge remains queued only. `users/notes` cannot enumerate all followers-only/direct notes, so a verified Misskey-side administrative endpoint/worker is required. Never substitute ad-hoc Misskey database or filesystem deletion.

Streaming has no durable acknowledgment or backfill here. Durability begins after intake DB commit; disconnections, downtime, overflow and pre-commit crashes may lose events. `localTimeline` also does not cover every visibility. Full coverage requires a reliable Misskey-side event outbox. Live Misskey behavior and production throughput remain unverified.

Runtime references: [Bun SQLite](https://bun.sh/docs/runtime/sqlite), [Bun SQL](https://bun.sh/docs/runtime/sql), [PostgreSQL locking](https://www.postgresql.org/docs/18/explicit-locking.html).
