# Moderation architecture

## Decision flow

```text
Misskey localTimeline note
        |
        v
Static rules generated from rules.md
        |
        +-- T1 --> human/protected-user gate --> suspend --> durable purge job
        |
        +-- T2 --> human/protected-user gate --> restrictive role
        |                                  \--> delayed LLM review job
        |
        +-- T3 -----------------------------> delayed LLM review job
```

Every transition is appended to `data/audit.jsonl`. Delayed-review jobs and T1 purge jobs are separately persisted as JSON Lines so a restart does not silently discard them. Job keys are idempotent per case and user. Each spool is capped by `MAX_QUEUED_JOBS`; reaching capacity fails closed instead of consuming disk without a bound.

## Component responsibilities

| Module | Responsibility |
|---|---|
| `index.js` | Read configuration and generated policy; install and remove process signal handlers |
| `application.js` | Compose dependencies, authenticate the local account, and manage startup and shutdown |
| `note-processor.js` | Bound and serialize incoming notes, isolate processing failures, and drain accepted work |
| `classification.js` / `matcher.js` | Deterministic classification without network calls |
| `moderation.js` | Create cases, schedule review, audit transitions, and track case completion |
| `enforcement.js` | Recheck authority and protected users before T1/T2 Misskey actions |
| `human-authority.js` | Reload human override state and fail closed on invalid state |
| `persistence.js` | Append-only audit and durable, deduplicated job spools |

`FileHumanAuthority` remains re-exported by `persistence.js` for existing callers. Audit events and durable job formats retain their existing shape.

The incoming processor accepts at most `MAX_PENDING_NOTES` notes (default 1,000), including the active note. Excess notes are rejected with an ID-only warning; they are not retried or backfilled. `/health` exposes pending count, capacity, total rejections, and total processing failures under `noteProcessing`. Only the streaming connection determines the HTTP health status, so operators should monitor these counters separately.

Health startup waits for the listening socket and rejects binding errors before opening the stream. Shutdown closes note acceptance, closes the stream, drains accepted processing, then closes health. The same cleanup applies if stream creation or streaming fails.

## Authority order

1. Human decision
2. Current protected Misskey state, including moderator status
3. Deterministic classification
4. LLM recommendation

`data/human-overrides.json` is the first explicit human-control surface. A matching user ID or note ID stops deterministic mutation and delayed LLM review. Invalid JSON fails closed and stops automation for affected incoming cases. A future Misskey-side integration should also project control-panel moderation actions into the same authority interface.

Both moderator and administrator flags block enforcement, including flags in `roles[]`. The [upstream administrative user endpoint](https://github.com/misskey-dev/misskey/blob/develop/packages/backend/src/server/api/endpoints/admin/show-user.ts) includes the user's roles in its response. T1 rechecks human authority after suspension is audited and immediately before scheduling historical deletion; a new human override at that boundary stops the purge job.

The LLM result uses a versioned JSON envelope. Allowed recommendations are `clear`, `T2`, `T3`, and `human-review`. `T1` is rejected in code. Deterministic T1 also cannot be downgraded by an LLM; only a human can override it.

## Current implementation boundary

The real-time classifier, T1 suspension, T2 role assignment, T3 recording, append-only ledger, durable job spools, human override gate, and LLM result validator are implemented.

Two workers remain deliberately unwired:

- **LLM review worker:** requires a provider/model choice and the server's actual terms-of-service document. The queue is persisted to `data/llm-review-queue.jsonl`, but no LLM request is made yet.
- **T1 historical deletion worker:** the public `users/notes` API applies normal visibility rules even to moderators, so it cannot guarantee deletion of followers-only and direct notes. Jobs are persisted to `data/t1-purge-queue.jsonl`, but a Misskey server-side hook or purpose-built admin endpoint is required before processing them as “all past notes.”

The service logs a warning when an enabled T1 rule exists so queued deletion cannot be mistaken for completed deletion.

## Human override file

```json
{
  "userIds": ["9abc..."],
  "noteIds": ["9xyz..."]
}
```

Editing the file affects subsequent automated actions. It does not undo actions already completed; those must be handled in the Misskey control panel and recorded as a human decision by the future control-panel integration.
