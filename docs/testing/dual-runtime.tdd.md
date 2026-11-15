# Node.js and Bun runtime evidence

The request was to run with pnpm and Node.js without installing Bun, while preserving Bun operation. Acceptance covers the default build/start/test/maintenance commands, standalone SQLite, distributed PostgreSQL, human authority and action journals across runtime changes, and explicit Bun-only commands.

## RED and GREEN

| Guarantee | RED evidence | GREEN evidence |
|---|---|---|
| Bun-free Node storage and persisted authority | `test/node-runtime.test.js`: 0 passed / 4 failed; Node could not import the Bun-only storage modules | Real Node SQLite file reopened by Bun, reverse read, human decisions and completed action journal preserved |
| Environment loading and Node build | The same target failed because environment loader and build script did not exist | Explicit process values override `.env`; Node builds with Bun absent from PATH |
| Node SQLite compatibility boundary | New storage-runtime target could not import its missing wrapper | Writable URI `mode=rw` opens existing files without creating missing files, parameterized queries, finalized wrappers and WAL/FULL checks pass |

Checkpoints on this branch: `0e2ac67` (RED), `377d6ae` (GREEN). Existing Bun tests were ported through a conditional test API: Vitest under Node, native `bun:test` under Bun. Bun-specific file, crypto and timer test helpers were replaced with standard APIs, without weakening moderation assertions.

## Verification performed

- **Node.js 24.18.0:** `pnpm run test:coverage` with the isolated PostgreSQL fixture: **227 passed across 28 files**, no skips/failures. Source coverage: **92.60% functions / 90.99% lines**, 81.77% branches.
- **Bun 1.4.4:** `bun test --coverage` against that fixture: **227 passed across 28 files**, no failures. Bun's all-files coverage: **88.81% functions / 88.25% lines**. The reports use different coverage engines and scopes and are not a direct performance comparison.
- Both PostgreSQL-specific targets passed **6 / 6** before the final full checks. An initial fixture with `max_connections=20` exhausted its connection slots because the suite keeps multiple five-connection pools alive until teardown. PostgreSQL reported `sorry, too many clients already`. The final controlled fixture used 100 connection slots, a direct `SELECT 1` check and one owner process for server/test lifetime. No production DB configuration was changed.
- Final review tightened the optional Node conformance probe: Bun hosts without Node 24 skip those cases, while the Node runner uses its own executable. The affected four tests passed again under both Vitest and native Bun. Bun-only update instructions and the deployed ESM metadata copy were also corrected.
- Bun was removed from PATH for a real offline frozen pnpm install, Node build, targeted pnpm test and standalone bundled maintenance CLI. Node was removed from PATH for a Bun build and standalone Bun CLI; Node-only conformance tests skipped cleanly. Temporary standalone directories contained the two build outputs and `package.json`, without project `node_modules`.
- Both compiled services authenticated to a controlled local HTTP API, opened a real WebSocket, and returned healthy worker/storage/stream status. Each test-owned service process was stopped afterward. No live Misskey credentials or user data were used.
- Mixed Node/Bun PostgreSQL processes produced one admission for the same note, one claim owner and one shared API grant. Invalid lease tokens were fenced; completed action journals and human overrides were visible through the other runtime.
- The standalone Node CLI migrated SQLite to PostgreSQL; the Bun CLI replayed that migration against the same state. Completed IDs, human decisions, journal and review job survived without duplicate work. The Node build contains its PostgreSQL dependency.
- Node and Bun builds passed. `git diff --check` passed. The controlled PostgreSQL fixture was stopped after every final verification run.

## Design and limits

Node uses built-in `node:sqlite` and Postgres.js; Bun retains its native SQLite and SQL drivers. The existing schema, queue algorithms, shared locking, awaited transactions, error sanitization and default dry-run behavior remain shared. No native SQLite addon or compilation toolchain is required for pnpm installation. Only esbuild's dependency build script is allowlisted in the pnpm workspace configuration.

Node supports 24 and newer; Bun is documented from the tested 1.4.4 baseline. `.env` is read at runtime, not embedded during builds. Deployment now defaults to Node, with an optional Bun Dockerfile and documented Bun systemd command. Actual Docker image builds, systemd service installation, live Misskey permissions and production load remain unverified. The LLM and historical purge consumers remain unwired.
