# Misskey moderation-note logging evidence

Journeys were derived from the request to make T1/T2/T3 results readable to administrators inside Misskey. Acceptance requires default logging in enforce mode, unchanged dry-run behavior, preservation of human text, accurate outcomes, bounded entries, privacy, and safe retry under the existing durable worker lease.

## RED evidence

| Guarantee | Observed failure before implementation |
|---|---|
| Default logging and configuration | Workflow/config/API target: 20 passed, 6 failed. T1/T2/T3 left only the original human memo; configuration and the admin API wrapper were absent |
| Dedicated writer safety | Writer target failed to import the missing implementation module |
| T1 result survives a log/purge retry | Targeted enforcement regression: 0 passed, 1 failed; only one suspension-result event was emitted across two attempts |

Current-branch RED checkpoints: `34691d5`, `da94df5`, `136fa0c`, `4c7b9c5`. These preserve the tests without rewriting prior history. The last checkpoint also retains the failing assertion for an unconfirmed deletion follow-up: a failed audit after enqueue must not be described as definite queue rejection.

Independent review also reproduced a slow `show-user` response bypassing the original freshness check: a 6000ms response with a 5000ms freshness bound still triggered a write. A targeted regression first failed (`expected false, received true`), then passed after measuring age from the guarded request start. Identifier validation was tightened to reject control/bidi characters without changing the API target.

## Verification targets

- `test/moderation-note.test.js`: preserved human prefix, Japanese/English summaries, stable markers, changed outcomes, uncertain send reconciliation, human precedence, protected accounts, capacity limits, sanitized metadata, definite rejection versus unknown result, and lease/cancellation fencing.
- `test/moderation-note-workflow.test.js`: real SQLite, worker recreation, action journal, shared Misskey budget, and controlled HTTP responses for all three tiers; dry-run and opt-out; failed log delivery without repeating successful T1/T2 restrictions.
- `test/durable-integration.test.js`, `test/reputation-integration.test.js`, `test/moderation.test.js`, `test/enforcement.test.js`, `test/application.test.js`: deterministic precedence, SFS-only T3 log delivery, uncertain enforcement, existing lifecycle and privacy checks.
- `test/config.test.js`, `test/misskey.test.js`: default/validated settings and the official endpoint payload with a guard after shared-budget acquisition.

## GREEN and delivery checks

- The final related target covers **93 tests across 9 files**. Its first combined run passed 91; two existing durable-integration fixtures lacked the official `roles` array after fail-closed response validation was added. Correcting that fixture produced **5 passed / 0 failed** for the affected file; the other 88 passing results remain applicable.
- The dedicated writer target passed **20 / 20**, including slow responses, aborts, rejected journal writes, marker preservation at size boundaries and successful suspension followed by failed purge admission.
- `bun test --coverage ./test/moderation-note.test.js` after the final wording correction passed **20 / 20**, with **92.31% functions / 91.13% lines** for `src/moderation-note.js`.
- `bun run build` passed, including **4 generated-policy checks** and both runtime/CLI bundles.
- `.env.example` remains ASCII without a BOM; `git diff --check` passed. No server or browser process was started. Changes are local SSH-signed commits; no push.

## External contract and limits

The official implementations of [admin/show-user](https://github.com/misskey-dev/misskey/blob/develop/packages/backend/src/server/api/endpoints/admin/show-user.ts) and [admin/update-user-note](https://github.com/misskey-dev/misskey/blob/develop/packages/backend/src/server/api/endpoints/admin/update-user-note.ts) were checked. The latter accepts `userId` and `text`, requires `write:admin:user-note`, and replaces the whole moderation note. Its English permission label is [Manage moderation note](https://misskey-hub.net/en/docs/for-developers/api/permission/).

The upstream API has no atomic append or compare-and-swap condition. Explicit shared overrides remain necessary before concurrent human edits; freshness checks reduce stale writes but cannot eliminate this race. The runtime uses the existing per-user durable claim and arbitrary-key action journal, with no storage schema change. New delivery tests use real SQLite and controlled Misskey responses; production PostgreSQL delivery and live Misskey permissions/UI behavior were not exercised. No live user note was changed. Review and historical purge consumers remain unwired, which is explicit in the generated summaries.
