# Crafters Automod project instructions

## Product objective

Build a Misskey moderation service with two deliberately separated stages:

1. Deterministic filtering compiled statically from the human-authored `rules.md`.
2. Delayed LLM review of T2 and T3 cases against the server terms of service.

The runtime must remain useful when the LLM provider is unavailable. Human moderator decisions always have higher authority than deterministic filters and LLM output.

## Severity contract

- **T1 — unambiguous severe abuse:** Only use for content that any reasonable reviewer would identify as spam or harmful abuse without contextual judgment. Immediately suspend the local account and enqueue deletion of its past notes. T1 must be idempotent, rate-limited, and fully audited.
- **T2 — strong restriction:** Assign the configured restrictive Misskey role and enqueue delayed LLM review. Do not suspend or purge merely because a rule is T2.
- **T3 — observe:** Apply no automatic Misskey restriction. Record the case and enqueue delayed LLM review.

When uncertain between tiers, select the less destructive tier. New rules default to T3 unless the human-authored policy explicitly and unambiguously requests a higher tier.

## Authority and conflict rules

Apply decisions in this strict priority order:

1. Current human moderator decision or override.
2. Existing human-managed Misskey state.
3. Deterministic T1/T2/T3 classification.
4. Delayed LLM recommendation.

Before every delayed or destructive mutation, re-check whether a human override or newer human action exists. Once a case is marked as human-decided, automation may record evidence but must not change the account, role, or notes for that case.

The LLM may review T2 and T3 cases only. It may recommend clearing a case, retaining T3, or moving between T2 and T3 when no human decision exists. It must never directly create a T1 suspension or past-note purge. A suspected T1 discovered by the LLM becomes a human-review recommendation.

## Architecture constraints

- Treat `rules.md` as human policy input and `rules.generated.json` as the only deterministic runtime rules artifact.
- Do not call an LLM in the real-time note ingestion path.
- Use a typed, versioned JSON envelope for LLM inputs and outputs. Reject malformed, unknown, or over-authoritative output.
- Keep deterministic classification, Misskey mutations, audit persistence, delayed review, and human overrides as separate components.
- Persist every case transition and external action with timestamps, actor (`deterministic`, `llm`, or `human`), rule IDs, reason, and outcome.
- All Misskey mutations must be idempotent and safe to retry. A failed action must be visible in the audit record.
- Queue sizes, retry counts, concurrency, and API rate limits must be bounded and observable.
- Never log access tokens or full private note content. Store only the minimum evidence required by the moderation policy.
- Do not silently repair or reinterpret LLM output with another LLM call.

## T1 deletion safety

- Suspend before starting historical deletion.
- Delete only notes authored by the exact local user ID attached to the case.
- Do not claim full historical deletion through `users/notes`: its visibility filtering cannot enumerate every followers-only or direct note. Use only a verified Misskey-side administrative endpoint or server worker for the purge.
- Paginate through that verified administrative boundary; never construct ad-hoc database queries or filesystem deletion commands from Automod.
- Respect Misskey API rate limits and persist progress so restart does not begin blindly from scratch.
- Stop deletion immediately when a human override is detected.
- Never delete a moderator or administrator account automatically.

## Delivery workflow

- Follow TDD for classification, precedence, idempotency, and failure paths.
- Keep `AUTOMOD_MODE=dry-run` as the default.
- Build before reporting completion.
- Report any behavior that cannot be verified against a live Misskey server.
- After appropriate verification, automatically create local commits grouped by cohesive changes unless the user explicitly requests otherwise.
- Use the configured SSH commit signing and English Conventional Commit messages.
- Do not push commits to a remote.
- Report the created commits in the completion summary.
