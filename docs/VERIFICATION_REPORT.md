# NEXORA — Verification report

Date: 2026-10-25. Environment: Node.js v24.22.1, npm 10.9.4, PostgreSQL 16
(installed via apt during this session; no Docker daemon was available, so the
provided `docker-compose.yml` was **not** executed). All commands below were run
from `~/workspace/nexora`.

## Commands executed and actual results

| Command | Result |
|---|---|
| `npm install` | 183 packages installed. Multer 1.x deprecation warning noted → upgraded to multer 2.x before testing. |
| `node --test "backend/tests/unit/*.test.js"` | 14 pass, 0 fail (state machine, codes, IDs, magic bytes, validation). |
| `node --test "backend/tests/integration/*.test.js" "backend/tests/unit/*.test.js" "e2e/*.test.js"` (pg-mem path) | 46 pass, 0 fail. pg-mem needed two shims, both test-only: `gen_random_uuid` + `char_length` registered in `backend/tests/helpers.js`. The migration SQL itself is unmodified real PostgreSQL. |
| `bash scripts/test-real-pg.sh` | **ALL GREEN** — every test file against real PostgreSQL 16, fresh database per file, migrations `001_init`, `002_message_client_id`, `003_history_seq` applied each time. |
| `DATABASE_URL=… npm run migrate` (fresh `nexora_dev` DB) | `001_init.sql applied`, `002_message_client_id.sql applied`, `003_history_seq.sql applied`, `done`. |
| Live server smoke test (`PORT=3100`, real DB) | `GET /api/health` → 200, `database: up`, `maps.configured: false`, `payments.configured: false`, `e2ee.enabled: false`. `GET /` → 200 (original CSS intact), `/src/app.js` → 200, `/socket.io/socket.io.js` → 200. Anonymous registration → server-issued `NXR-UCBYFTRX`. |
| Bugs found and fixed during testing | (1) `conflict` not imported in deliveries route (500 on second claim). (2) Account-deletion violated `users_password_or_anonymous` CHECK (fixed: deletion sets `is_anonymous=TRUE`). (3) History `ORDER BY created_at` ties on real PG (fixed: migration 003 sequence + `ORDER BY seq`). (4) pg-mem lacks correlated-subquery support (rewrote list/unread/DM queries to joins + JS merges — same semantics on real PG). (5) Static frontend path was one level too high (fixed `config.root`). (6) Rate-limit budget shared across tests in one file (auth tests raise the cap for themselves; the limiter itself is tested separately with defaults). |

## Feature verification table

| Feature | Implementation status | Test status | Evidence or limitation |
|---|---|---|---|
| Backend API | Implemented | Tested (real PG) | Express routes for auth, users, conversations, messages, files, deliveries, couriers, admin, health; 46 tests green on real PG 16. |
| Persistent database | Implemented | Tested (real PG) | Migrations 001–003 apply cleanly; E2E "reload" test re-reads delivery + messages from the DB after reconnect. |
| Authentication | Implemented | Tested (real PG) | Anonymous server-issued IDs, register/login, claim, logout revocation, deletion; no account-enumeration (identical 401s); CSRF enforced (missing token → 403). |
| Server-side authorization | Implemented | Tested (real PG) | IDOR sweep (DM/conversation/message/read/leave all 403 for non-members), file download scope checks, admin-only endpoints 403 for users, last-owner protection. |
| Private real-time chat | Implemented | Tested (real PG) | HTTP + Socket.IO; E2E test proves Bob receives Alice's message over the socket; unauthenticated socket rejected; membership checked on join and send. |
| Private groups | Implemented | Tested (real PG) | Group create/add/remove; member cannot add; removed member immediately loses read + send. |
| Media sharing | Implemented (local provider) | Tested (real PG) | PNG upload + attach + signed download; fake PNG rejected by magic bytes; non-member download 403; expired URL 403; parcel photo sender-only + images-only. S3 provider: **not implemented** (no credentials). |
| GPS and maps | Partial (storage + honest 503) | Tested (real PG) | Coordinates accepted/stored/validated; route endpoint returns `503 MAPS_NOT_CONFIGURED`. No provider configured; no route/ETA is fabricated. Frontend has GPS-on-tap + manual areas. |
| QR and delivery verification | Implemented | Tested (real PG) | QR PNG of order reference only; wrong code → 400 + attempt consumed; correct code → state advance; replay → 400; sender-only code view. Code expiry test: **not run** (would need clock control; expiry logic shares the code path tested for used/locked). |
| Courier assignment | Implemented | Tested (real PG) | Atomic claim (second courier → 409); sender cannot claim own order; non-courier cannot claim. Concurrency is by SQL atomicity, not a parallel-load test — a true concurrent-race test was **not run**. |
| Security controls | Implemented | Tested (real PG) | SQLi stored literally (tables intact), XSS stored raw + frontend-escaped, CSRF, rate limits (login 10/min, messages 30/min — both observed 429), Helmet CSP, audit logging. |
| End-to-end workflows | Implemented | Tested (real PG) | E2E test: register → DM over socket → delivery lifecycle → reload persists. |
| Frontend integration | Implemented | Smoke-tested (server) | Serves 200 with original CSS; API wiring written for all tabs. **Not tested in a real browser** — no browser automation run was performed against the new frontend; socket.io client file serves 200. |
| Deployment (Docker) | Implemented (files only) | **Not tested** | `docker-compose.yml` + `Dockerfile` provided; Docker daemon unavailable in this environment, so the compose stack was never booted. |
| TypeScript | **Not implemented (deviation)** | N/A | Plain JavaScript (ESM) + Zod was chosen for zero-build runnability; documented in `docs/PLAN.md` and README. Module layout mirrors the TS structure. |
| Payments / push / E2EE / email recovery | **Not implemented** | N/A (honest 503s) | Endpoints and health report state this; nothing is faked. See README "What is NOT implemented". |

## What "tested" means here

- "Tested (real PG)" = the named behavior is covered by an automated test that
  passed against PostgreSQL 16 in this session (via `scripts/test-real-pg.sh`).
- "Smoke-tested (server)" = a live HTTP check, not a full user journey.
- Anything marked "Not tested" or "Not implemented" was deliberately left that
  way and is labeled as such in the product too (health endpoint, UI banners).
- No test was ever marked passed without running it. Two real bugs found by the
  real-PG run (history ordering, missing import) are listed above with fixes.
