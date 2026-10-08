# LinguaMentor system architecture

- **Status:** decisions are marked one by one in section 4. "Decided" means Frank delegated the call to the CTO on 2026-09-30. "Proposed" means it waits for Frank's acceptance. Each accepted decision becomes an ADR (pure architecture) or a PRD edit (anything that changes product behaviour), and this file changes in the same PR.
- **Date:** 2026-09-30, revision 2 (team-aware).
- **Owner:** CTO. Product owner: Frank.
- **Scope:** how the system is built, secured, run and delivered. What the product does lives in the PRD, which is private. This file cites PRD sections by number only.
- **Evidence rule:** every claim about a vendor, library or standard was checked against the vendor's own page, the package registry or the source. Estimates are labelled as estimates. Section 22 lists what could not be checked.

**What changed in revision 2.** The team (frontend, backend, DevOps, QA, plus a senior AI engineer to hire) replaces the single-developer assumption. The backend becomes three runtimes instead of one: TypeScript owns the database and the queue, and Python owns scoring as a stateless service. Error tracking is self-hosted. The repository gets an explicit licence, and the scoring prompts and rubrics move to a private repository.

---

## 1. Constraints that shape everything

| Constraint | Consequence |
|---|---|
| A small team: frontend, backend, DevOps, QA, and a senior AI engineer | Boundaries between runtimes follow team boundaries, so people can work in parallel without editing each other's code. |
| No infrastructure budget before launch | Free tiers or self-hosting only. The planned costs are a domain, a paid Neon plan at launch and LLM usage. |
| Users are adults on mid-range Android phones over 3G-class links (PRD §4.1, §11.7) | Server-rendered pages, small JavaScript budgets, no heavy client state. |
| The product sells honest scores (PRD §2.3) | A score shown as calibrated when it is not is the worst failure. The design makes that state impossible to reach by accident. |
| Essays are personal data sent to a US LLM vendor (PRD §13.3) | Minimise what leaves, log none of it, make erasure provable. |
| The repository is public | Code is visible. Anything that is our advantage or someone else's licensed material (tuned prompts, rubric text, anchor essays, prices) lives elsewhere. |

**Quality attributes, in priority order:** score integrity, security and privacy, operability by a small team, cost, performance on weak devices, scalability.

**Non-goals:** microservices beyond the three runtimes below, Kubernetes, multi-region, event sourcing, CQRS, GraphQL, hexagonal or DDD layering.

---

## 2. Capacity and scaling

### 2.1 Design point

The PRD gives targets for paying users, not for load, so the load figures below are derived. **They are estimates until the load test in section 18 measures them.**

| Figure | Value | Basis |
|---|---|---|
| Paying users at 12 months | 200 to 500 | PRD §5.3 |
| Registered users implied | 4,000 to 25,000 | 200 at 5% conversion, 500 at 2% |
| **Design point** | **10,000 registered, 1,000 to 2,000 active a day, 100 to 300 online at peak** | 10 to 20% daily activity is an assumption |
| API requests at peak | 30 to 60 per second | 300 users, one request every 5 to 10 seconds |
| Essays at peak | about 7 per minute | 2,000 active × 1 essay a day, 20% of them in the busiest hour |
| LLM tokens per essay | about 10,000 | Rubric, anchors, essay and feedback; measured once the model is pinned |

### 2.2 Where it saturates first

1. **Neon compute** on the free plan. Production moves to the paid Launch plan before real users, where compute autoscales.
2. **VM memory.** Redis, the tunnel connector and the gateway were measured together: 722 MB idle and 897 MB under load on a 6 GB server (section 3). The other processes are still unmeasured.
3. **Scoring throughput.** With 10 concurrent scoring jobs and an assumed 25 seconds per evaluation, the worker handles 20 to 30 essays a minute, 3 to 4 times the peak estimate.
4. **OpenAI rate limits are not the constraint.** The Build tier, reached after $5 of credit, allows 5,000 requests and 1,000,000 tokens per minute on the flagship models ([OpenAI](https://developers.openai.com/api/docs/guides/rate-limits)). That is about 100 essays a minute at the estimate above.

### 2.3 How it scales

Three rules keep scaling cheap:
- The web, API and scoring processes hold no state. Sessions and data live in Postgres, and counters live in Redis.
- Slow work (scoring, email, audio) goes through a queue.
- The database is managed.

| Stage | Trigger | Action | Effort |
|---|---|---|---|
| Launch | none | One VM per environment | none |
| 1 | Sustained CPU or memory pressure | Larger VM shape, more Neon compute, higher worker concurrency | Configuration |
| 2 | One VM is not enough | A second VM running more copies of web, API, worker and scoring; one tunnel connector per VM | Hours |
| 3 | Voice traffic, or scoring outgrows a VM | Voice and scoring on their own machines (PRD §11.6), Neon read replicas | Days |

What is not cheap: leaving Neon, or making Redis highly available. Neither is expected before tens of thousands of active users.

---

## 3. Architecture at a glance

```
  Learner (Android browser or installed PWA)
        |  HTTPS
  Cloudflare edge: DNS, TLS, CDN, WAF
        |  Cloudflare Tunnel (outbound only; no open ports on any VM)
  +-----+---------------- app VM, one per environment (Arm) --------------------+
  |  cloudflared --+-- /api/*  --> api      Fastify (TypeScript)                 |
  |                +-- /*       --> web      Next.js 16 (TypeScript)              |
  |                                 worker   BullMQ consumer, same image as api   |
  |                                 scoring  FastAPI (Python), stateless, internal|
  |                                 redis    queues and rate-limit counters       |
  +-----+-------------------+-------------------+-------------------------------+
        |                   |                   |                 private network
   Neon Postgres       Cloudflare R2       OpenAI, Resend,          |
   one per env,        audio, dumps,       Paystack          monitoring VM (AMD micro)
   written by          content bundles                        Bugsink: error tracking
   api and worker only
```

**Style:** a modular monolith for everything stateful (TypeScript), plus one stateless scoring service (Python) that owns the AI work. One database, and only the TypeScript side touches it.

**Containers per app VM:**

| Container | Language | Role | Reachable from | Idle memory measured |
|---|---|---|---|---|
| web | TypeScript | Next.js server | tunnel, path `/*` | not measured |
| api | TypeScript | HTTP API, database owner | tunnel, path `/api/*` | 93 MB (current gateway, modules loaded) |
| worker | TypeScript | Queue consumer, same image as api | nothing | not measured |
| scoring | Python | Scoring engines, calibration code path | api and worker only | 47 MB (current ai-service, app imported) |
| redis | | Queues and rate-limit counters | api and worker only | not measured |
| cloudflared | | Tunnel connector, a host service (not a container) | outbound only | measured with redis and api: 722 MB idle, 897 MB under load, whole host |

Idle figures are floors. `cloudflared` runs as a pinned systemd service on the host, so a Docker failure cannot lock the team out. Staging runs on 4 GB and production is sized after staging's week of measurements (section 17.7).

---

## 4. Decisions

| # | Decision | Status | Alternatives rejected | Patches |
|---|---|---|---|---|
| D1 | Three runtimes: web (TypeScript), api and worker (TypeScript, the only database writer), scoring (Python, stateless). The Python worker is removed. | Decided | Four runtimes with three database writers. Everything in TypeScript. Everything in Python. | PRD §11.1, §11.8, §11.9, §12 |
| D2 | Postgres 18 on Neon, one database per environment. Kysely for queries and migrations, forward-only, owned by the api package. | Proposed | Drizzle (1.0 still a release candidate). Prisma. Alembic. | PRD §11.8 (Migrations) |
| D3 | BullMQ 6 on Redis. Redis holds nothing that cannot be rebuilt. | Proposed | BullMQ's Postgres backend. pg-boss. | none |
| D4 | Server-side sessions in Postgres, opaque cookie, layered CSRF defence. No JWTs. | Proposed | RS256 access token plus rotating refresh cookie. | PRD §11.4, §11.9, §13.1 |
| D5 | One origin. The tunnel routes `/api/*` to the API and everything else to the web app. No CORS. | Proposed | Separate `app.` and `api.` hostnames. | PRD §13.7 (CORS line) |
| D6 | Immutable scoring profiles. A calibration baseline attaches to a profile, and the display gate resolves through it. | Proposed | Baseline resolved by exam type. | PRD §9.2 (implements it) |
| D7 | Prompts, rubrics, anchors and exam configs live in a private content repository, shipped as a hash-pinned bundle. | Decided | Content in the public repository. Content baked into images. | none |
| D8 | Contracts: zod 4 shared by web and api. The scoring service's OpenAPI spec generates the TypeScript client. Both checked in CI. | Proposed | Types kept by hand on both sides. | PRD §11.8 (Shared contracts) |
| D9 | Usage caps enforced in Postgres in the same transaction that creates the work. | Proposed | Redis counters. | PRD §8.5 (mechanism only) |
| D10 | Error tracking self-hosted with Bugsink, which accepts the official Sentry SDKs. Logs and uptime on Grafana Cloud Free. | Decided | Paid Sentry. Sentry's open-source plan. Self-hosted Sentry. | none |
| D11 | Next.js 16, server components first, `next-intl`, PWA manifest only. | Proposed | Client-rendered pages with in-memory tokens. | PRD §11.8 (PWA wording) |
| D12 | Module boundaries enforced in CI (dependency-cruiser for TypeScript, import rules for Python). | Proposed | Convention only. | none |
| D13 | Local, staging and production, plus a throwaway CI environment per pull request. Oracle Always Free VMs, Cloudflare Tunnel, GitHub Actions and GHCR. Images built once and promoted by digest. | Proposed | Coolify. Vercel Hobby. Rebuilding per environment. | PRD §11.1, §11.10 |
| D14 | Tests run against real Postgres and Redis, with a fake LLM by default. | Proposed | Fakes for the database. | none |
| D15 | Node 24 LTS, pnpm and strict TypeScript. Python 3.14, uv, ruff and strict mypy. | Decided | Python 3.12 (security fixes only), Poetry. | none |
| D16 | The public repository carries an explicit proprietary licence. | Decided | No licence file. MIT or Apache. | none |
| D17 | Current app names stay (`frontend`, `api-gateway`, `ai-service`). `apps/worker` is removed and its jobs move into `api-gateway`. | Decided | Renaming to `web` and `server`. | none |

---

## 5. D1: three runtimes, one database owner

### 5.1 The defects being fixed

The current layout has four runtimes. The number is not the problem. Two defects are:

1. **Three services write the same database.** A new column must be edited in the model, the Python repository, the worker's queries and the gateway's queries in one change, and nothing checks that they agree.
2. **Every shape is defined twice**, as zod in TypeScript and pydantic in Python, kept in sync by hand. The AI service also accepts a learner id from whoever calls it and has no authentication.

A team makes both worse, because more people change the schema in parallel.

### 5.2 The options

| Option | Database writers | Languages | What it costs | Verdict |
|---|---|---|---|---|
| Keep four runtimes | 3 | 2 | Nothing now; both defects stay | Rejected |
| Everything in Python | 1 | 2 (Next.js stays TypeScript) | Rewrite the auth code, the best-tested part of the repo; lose zod contracts shared with the frontend; use the younger Python BullMQ client | Rejected |
| Everything in TypeScript | 1 | 1 | Port the scoring engines; the AI engineer works in TypeScript, away from Python's evaluation and statistics tools; future speech work would need Python anyway | Rejected with a team |
| **TypeScript owns state, Python owns scoring** | **1** | **2** | Move the worker (about 800 lines) into the api package; strip database code from the AI service | **Chosen** |

### 5.3 Why this split

- **One owner for the database.** Only `api-gateway` (its api and worker processes) connects to Postgres, and it owns the migrations.
- **The scoring service is stateless.** It takes an essay, an exam task and a profile hash, and returns a validated score. It never sees who the learner is, so it cannot leak or mix up learner data.
- **One boundary between languages**, carrying plain data with no database behind it. That is the easiest kind of boundary to contract-test.
- **Calibration runs the production engine.** The calibration harness imports the same Python engine the service runs, which is what the calibration brief requires.
- **Team fit.** The AI engineer works in Python, where the evaluation and statistics tools are. Backend owns the TypeScript side. Neither edits the other's code to ship a change.
- **Future fit.** Speech work in Phase 2 (word error rates, pronunciation) is Python territory and belongs in the same service.

### 5.4 What changes in the current code

| Part | Now | After |
|---|---|---|
| `apps/frontend` | Next.js 14 | Next.js 16, same app |
| `apps/api-gateway` | Fastify API, `pg` | Same API, plus the worker entrypoint, Kysely and the migrations |
| `apps/worker` (Python) | Queue consumer and database writer | Removed; its jobs become TypeScript jobs in `api-gateway` |
| `apps/ai-service` | FastAPI with repositories, Alembic and learner ids | FastAPI without a database: engines, providers, calibration harness |
| Alembic migrations | Owned by ai-service | Retired; a fresh initial migration in `api-gateway` (nothing is deployed) |

Kept as they are: Fastify, the auth code's password handling and parameterised SQL, the module layout of routes, services and schemas, BullMQ, Redis, Neon, the provider interface pattern, the engines' logic and the tests' approach.

**What would change this decision:** the scoring service turning out to need learner history for a feature. Then the api passes the history in the request; the service still never queries the database.

---

## 6. Ownership by role

| Area | Owner | Reviews |
|---|---|---|
| `apps/frontend` | Frontend | Backend for API use, QA for accessibility |
| `apps/api-gateway` (api, worker, migrations) | Backend | CTO for schema changes |
| `apps/ai-service`, calibration harness, private content repository | AI engineer | CTO for anything that changes a scoring profile |
| `packages/contracts`, the scoring OpenAPI spec | Backend and AI engineer jointly | Both must approve a change |
| `infra/`, `.github/`, VMs, Cloudflare, Bugsink | DevOps | CTO for anything touching secrets or network exposure |
| Test strategy, end-to-end suite, staging checks, load test | QA | Owners of the code under test |

`CODEOWNERS` encodes this table so GitHub requests the right reviewers automatically.

**Profile for the AI engineer to hire:** senior Python engineer with production LLM experience: structured outputs, prompt versioning, evaluation harnesses, and statistics for rater agreement (quadratic weighted kappa, bias analysis, confidence intervals). Automated essay scoring or psychometrics experience is a strong plus. Working French is a strong plus, because the first exam is TCF and the rubrics, essays and examiner grids are in French.

---

## 7. Repository and code structure

**Public repository** (`LinguaMentor/Lingua-Mentor-v2`):

```
apps/
  frontend/               Next.js 16
  api-gateway/            Fastify API and BullMQ worker: one package, one image
    src/
      http.ts             API entrypoint
      worker.ts           worker entrypoint
      cli.ts              migrate, content:sync, promote-baseline, sweep
      modules/<feature>/  routes, service, repository, jobs
      platform/           db, redis, queue, config, logging, errors
      providers/          email, payments, storage, scoring client: interface, adapter, fake
    migrations/           Kysely migrations
  ai-service/             FastAPI scoring service, stateless
    app/
      api/                routes: score, manifest, health
      engines/            pure scoring logic per scoring model
      providers/          llm (openai, fake); stt and tts later
      content/            bundle loader and hash verification
      calibration/        harness, same engine, statistics in an optional group
    fixtures/content/     a public dummy bundle for local and CI
    openapi.json          committed spec; CI fails if it drifts
packages/
  contracts/              zod: requests, responses, errors, job payloads, queue names
infra/                    compose files, VM bootstrap, tunnel config, Bugsink
```

**Private repository** (`LinguaMentor/linguamentor-content`): exam and level configs, rubric descriptors, scoring prompts, anchor essay sets and the bundle build script. Section 10.3 explains why and how it ships.

Lessons are not in either repository. Reviewers author and approve them in the reviewer console, and they are stored as versioned rows in the database (PRD §8.3).

**Layering in `api-gateway`.** Inside a module: `routes -> service -> repository -> platform`.
- Routes parse, authorise and call a service. They hold no decisions.
- Services own decisions and transactions.
- Repositories hold all SQL for the module's own tables and return typed rows.
- SRS and readiness logic is pure, with no imports from `platform`.
- A module reaches another module only through its exported service, never its repository.
- `modules/voice` is never imported by other modules (PRD §11.6).

dependency-cruiser (18.4.0) enforces these rules in CI. In `ai-service`, `engines/` may not import `api/` or `providers/` directly; an import-linter rule enforces it.

**Modules and the tables they own.**

| Module | Owns |
|---|---|
| identity | users, sessions, email tokens, roles |
| learners | profile, goal, interface language, consent flags |
| placement | placement results |
| learning | skill vectors, SRS state, daily sessions, lesson progress |
| content | lesson versions, audio assets, reviewer approvals |
| writing | writing sessions, score breakdowns, appeals |
| scoring | exam levels and tasks, scoring profiles, calibration baselines, model runs, the display gate |
| billing | catalogue, purchases, entitlements, usage counters, payment events |
| notifications | in-app notices, email outbox |
| reviewer | audit log, console endpoints |
| analytics | events, never essay text |
| voice, chat | Phase 2, parked, isolated |

This replaces the ownership table in PRD §12.

---

## 8. Data architecture

### 8.1 Database
- **Postgres 18 on Neon**, one project per environment. Neon supports Postgres 14 to 18 ([Neon](https://neon.com/docs/postgresql/postgres-version-support)). Local and CI run the same major version in Docker. PostgreSQL 18 has a built-in `uuidv7()` ([release notes](https://www.postgresql.org/docs/release/18.0/)), which we use for primary keys.
- **One writer.** Only `api-gateway` holds database credentials.
- **Conventions.** Tables snake_case plural. Primary keys `uuid DEFAULT uuidv7()`. Timestamps `timestamptz` in UTC. Scores `NUMERIC(4,2)`, carried as strings, never JavaScript numbers. Money as an integer in minor units plus a currency code. Enumerations as `text` with a `CHECK`, because adding a value to a native enum is awkward in a migration.

### 8.2 Queries and types
- **Kysely 0.29** (released 2026-09-16) builds parameterised SQL. No string-built SQL. All queries live in repositories.
- **Row types are generated** from the migrated database with `kysely-codegen`. CI regenerates and fails on any diff. kysely-codegen releases slowly (last on 2026-02-16); if it stalls, hand-kept types guarded by the integration tests replace it.
- **Why not Drizzle.** Its stable line is 0.45 and 1.0 has been a release candidate since at least May 2026, so adopting it now means a migration soon. Kysely stays close to SQL, and we rely on `FOR UPDATE SKIP LOCKED`, `ON CONFLICT` and `NUMERIC` directly.

### 8.3 Migrations
- Files in `apps/api-gateway/migrations/`, applied by `cli migrate`. **Forward-only.**
- Run as a one-off container step before the rollout, never at boot. The deploy workflow's concurrency group prevents two runs at once.
- Migrations use Neon's **direct** connection. Neon says to use a direct connection for migrations and `pg_dump`, because its pooler runs in transaction mode without advisory locks, `SET`, `LISTEN/NOTIFY` or temporary tables ([Neon pooling](https://neon.com/docs/connect/connection-pooling)).
- **Expand, then contract.** Each migration works with the previous release's code. A column is dropped one release after the code stops using it. Rollback means redeploying the previous image, never reversing a migration.
- CI applies every migration to an empty database on every pull request.

### 8.4 Connections
- Application traffic uses Neon's **pooled** endpoint. Timeouts are set on the database role (`statement_timeout`, `idle_in_transaction_session_timeout`) because the pooler keeps no session state.
- Every pool sets `connectionTimeoutMillis`, logs from an `error` listener, and closes on shutdown.
- **Scale to zero.** A free Neon compute suspends after 5 minutes idle and wakes in typically a few hundred milliseconds ([Neon](https://neon.com/docs/connect/connection-latency)). The free plan allows 100 CU-hours a month, and a compute that never sleeps at 0.25 CU uses about 182 (0.25 × 730). So the liveness endpoint never queries the database, the worker waits on Redis, and nothing polls Postgres on a timer.

### 8.5 The scoring integrity model

The honest-grader promise, enforced by the database.

- `scoring_profiles` (immutable): `exam_task_id`, `bundle_sha256`, `prompt_hash`, `rubric_hash`, `anchor_set_version`, `rules_version`, `model_id`, `decoding` (JSON, includes reasoning effort, because current OpenAI reasoning models reject `temperature` unless reasoning effort is `none`), and a `profile_hash` over all of these.
- `calibration_baselines` (immutable): `profile_id`, metrics, held-out sample size, examiner count, inter-rater statistic, `signed_off_by`, `displayed_on_reports`.
- `writing_sessions.scoring_profile_id` records which profile scored each essay.
- **Display rule:** a score is shown only if a baseline exists for the session's own profile with `displayed_on_reports` true. One SQL function implements it, and it is unit tested.
- **Who can write these tables.** The application role has `SELECT` only on `scoring_profiles` and `calibration_baselines`. A separate `calibration_admin` role, used only by `cli content:sync` and `cli promote-baseline` in a protected deploy step, writes them. A bug or injection in the application cannot fabricate a calibrated state.
- `ENFORCE_CALIBRATION_GATE` defaults to true, and production refuses to boot with it off.
- `model_runs` is an append-only ledger: profile, tokens in and out, latency, cost estimate, request id, and optionally the raw output (retention in 10.5).

### 8.6 Erasure
`eraseLearner(userId)` runs in one transaction. It overwrites identity fields, deactivates the account, deletes the learner's sessions and nulls every free-text column. Score and model-run history stays, because it carries no personal data once identity is gone (PRD §13.2).
- **Provable coverage.** Every personal-text column carries the column comment `pii:text`. A test reads `information_schema` and asserts that erasure clears every such column, including JSON columns that quote the essay.
- **In-flight work.** The worker's save queries check that the user is still active, so a job in flight cannot write feedback back after erasure.
- The scoring service stores nothing, so erasure has nothing to do there.
- Erasure requires the password again and takes effect on the next request, because sessions live in the database.

### 8.7 Backups
- Neon keeps 6 hours of history on Free and up to 7 days on Launch ([pricing](https://neon.com/pricing)). PRD §11.7 asks for 7 days, so production moves to Launch before real users.
- A nightly `pg_dump` over the direct connection goes to R2, kept 30 days, run by a scheduled GitHub Action. A missed run raises an alert.
- A restore is performed and timed before launch and after any provider change.

---

## 9. Asynchronous work

### 9.1 What is queued
Writing evaluation, appeal evaluation, daily session generation, the nightly SRS batch, email, in-app notifications, lesson audio generation (later), and the sweeper. All consumers run in the TypeScript worker.

### 9.2 Rules
- **The payload is a pointer** (`{ id, requestId }`), and `jobId` equals the entity id, so a retry cannot double-score. The row is the contract.
- **Claim guard.** `UPDATE ... SET status = 'processing' WHERE id = $1 AND status IN ('submitted', 'processing')` with a lease timestamp; a stale lease can be reclaimed.
- **Enqueue after commit.** If the enqueue fails, the row stays `submitted`. The **sweeper**, a BullMQ job scheduler running every minute, re-enqueues rows stuck in `submitted` for over 2 minutes or in `processing` past their lease, with the same `jobId`. This makes losing Redis survivable.
- **Retries.** Retryable failures (provider 429 and 5xx, timeouts) back off exponentially from 10 seconds and honour `Retry-After`. Permanent failures fail fast.
- **Every non-terminal state reaches a terminal one** (PRD §11.3). The final attempt marks the row `failed` with a reason code, and a failed evaluation does not count against the daily cap.
- **Shutdown.** On SIGTERM the worker stops taking jobs and finishes in-flight work; `stop_grace_period` exceeds the scoring timeout.
- **Schedulers.** BullMQ 6 removed the legacy repeatable-job APIs, so we use Job Schedulers and `deduplication` from the start ([migration guide](https://github.com/taskforcesh/bullmq/blob/master/docs/gitbook/guide/migrations/migrate-from-v5-to-v6.md)).
- **Queue names and payload schemas** are exported from `packages/contracts`.

### 9.3 Redis
Redis holds queues and rate-limit counters only.

| If Redis is lost | Effect |
|---|---|
| Queued jobs | The sweeper re-enqueues from the database |
| Rate-limit counters | Reset; auth routes fail closed while Redis is unreachable |
| Sessions | Unaffected; they live in Postgres |

BullMQ requires `maxmemory-policy noeviction` and recommends AOF persistence with one-second fsync ([BullMQ](https://github.com/taskforcesh/bullmq/blob/master/docs/gitbook/guide/going-to-production.md)). We also cap `maxmemory` and set `removeOnComplete` and `removeOnFail` counts.

**Why not BullMQ's Postgres backend.** Its docs call Redis "the default and the most battle-tested option", and its workers hold a `LISTEN` connection that may keep a Neon compute awake (undocumented). Revisit after leaving Neon's free plan.

### 9.4 Writing evaluation flow

```
 1  api: validate, check entitlement and daily cap, insert writing_session (submitted),
       one transaction, commit
 2  api: enqueue { id, requestId } with jobId = id; return 202 with the session id
 3  worker: claim (submitted -> processing); load the session and the pinned profile
 4  worker: POST scoring /api/v1/score { profile_hash, exam_task, prompt_id, essay, request_id }
 5  scoring: deterministic rules (word floor, copied-prompt stripping)
 6  scoring: model call with the profile's model and decoding; structured output; one
       correction retry; composite computed in code
 7  scoring: returns scores, feedback, profile_hash, model, usage
 8  worker: reject if the returned profile_hash differs from the pinned one
 9  worker: one transaction: score_breakdown, model_run, session -> scored
10  web polls the session; read time applies the display rule (8.5)
```

The gate is checked when a score is read, so a later baseline reveals earlier scores made under the same profile.

---

## 10. AI architecture

### 10.1 The scoring service
- **Stateless.** No database, no Redis, no learner identity. Input is an essay, an exam task, a prompt id and a profile hash. Output is a validated score.
- **Endpoints:** `POST /api/v1/score`, `GET /api/v1/manifest` (the loaded bundle's exam catalogue and profile hashes), and health. Phase 2 adds speech endpoints here.
- **Internal only.** It is not in the tunnel's ingress rules and publishes no host port. Callers send a per-environment service token in the `Authorization` header, compared in constant time. OpenAPI docs are disabled in production.
- **Layers:** engines are pure (build the prompt, parse the reply, compute the composite). A provider interface wraps each vendor; engines never import a vendor SDK. The `fake` provider returns fixtures and is the default in local and CI.
- **Stack:** Python 3.14, FastAPI 0.142, pydantic 2.13, the official `openai` SDK, uv, ruff and strict mypy. Statistics libraries (scipy, scikit-learn) sit in an optional group used only by the calibration harness, not in the service image. Python 3.12, which the repo uses today, receives security fixes only, and 3.13's bugfix support ends on 2026-10-01, so 3.14 (bugfix support until 2027-10) is the target ([endoflife.date](https://endoflife.date/python)).

### 10.2 Scoring profiles
- A profile is the hash of everything that can change a score: the content bundle's prompt, rubric, anchors and rules, plus the model id and decoding settings.
- Each environment pins its profile set through the bundle hash in its configuration. Nothing uses "latest".
- **Any change creates a new profile, and a new profile needs its own calibration.** A fallback provider is another profile; without a baseline, its scores are withheld (PRD §9.2).
- **Appeals** re-score with the same profile. A re-check under any other configuration is never labelled calibrated.

### 10.3 Private content bundle
**Why private.** Tuned prompts and anchor essays are the product's core advantage. Anchor essays come from consented learners and must never be public. Public prompts would also help anyone craft essays that game the scorer. Rubric wording may be licensed (PRD §7.2).

**How it ships.**
1. The AI engineer changes content in the private repository through reviewed pull requests.
2. CI there validates the bundle and uploads `bundle-<sha256>.tar.gz` to a private R2 bucket. Bundles are immutable and addressed by hash.
3. Each environment's configuration in the public repository names the bundle hash it runs. Promoting a bundle to production is a change to that value, which goes through the production approval gate.
4. At boot, the scoring service downloads the bundle with read-only R2 credentials, verifies the hash and refuses to start on a mismatch. A cached copy on the VM covers an R2 outage.
5. At deploy, `cli content:sync` reads the service's manifest and registers exam levels, tasks and scoring profiles in the database.

Images stay public on GHCR and contain no prompts. This matters because GitHub Free includes only 500 MB of private package storage, while public packages are free ([GitHub](https://docs.github.com/en/billing/concepts/product-billing/github-packages)). Local development and CI use the dummy bundle in `ai-service/fixtures/content/`.

### 10.4 Model output
- Structured output through the OpenAI SDK, validated again with pydantic. One correction retry, then a permanent failure.
- The essay is fenced content, never instructions. Writing prompts come from a server-owned bank, so no learner controls the scoring prompt.
- Injection cases belong in the calibration gate's adversarial set (PRD §13.7; [OWASP LLM01](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)).

### 10.5 Data handling
- Only essay text and the task prompt leave the system. No name, email or id is sent.
- OpenAI keeps abuse-monitoring logs for up to 30 days by default. Zero data retention needs OpenAI's approval, and Batch is not eligible ([OpenAI](https://developers.openai.com/api/docs/guides/your-data)). The privacy notice says so, and counsel decides what Cameroon's transfer rule requires (PRD §13.3).
- Raw model output can echo the essay, so it is personal text: purged on erasure and by a retention job (default 90 days, to confirm with counsel).

### 10.6 Cost and abuse control
- The daily cap lives in Postgres (D9): a `usage_counters` row per learner per day, updated with `INSERT ... ON CONFLICT DO UPDATE ... WHERE used < cap RETURNING` in the transaction that creates the session.
- Each environment has its own OpenAI project with a **hard monthly spend limit**, which returns HTTP 429 once reached ([OpenAI](https://help.openai.com/en/articles/9186755-managing-your-work-in-the-api-platform-with-projects)). Local and CI never call OpenAI.
- Input caps matched to column sizes, an output token cap on every call, and per-user rate limits on AI routes.

### 10.7 Calibration
1. Examiner-graded, consented, anonymised essays are kept in private storage, never in either repository.
2. The harness in `ai-service/app/calibration` scores them with the production engine under a chosen profile and computes every gate metric on the held-out set (PRD §9.3).
3. It writes a report that carries the profile hash and fails if any essay failed silently.
4. `cli promote-baseline report.json` checks the hash, the gates and the failure count, then inserts the baseline through `calibration_admin`.

The weekly drift check (PRD §9.9) starts as a manual command.

### 10.8 Model lifecycle
OpenAI gives at least 6 months' notice for generally available models, and snapshots do retire: `gpt-5-2025-08-07` shuts down on 2026-12-11, about 16 months after release ([deprecations](https://developers.openai.com/api/docs/deprecations)). Budget a recalibration roughly once a year. The pinned model is a Phase 0 decision and is not fixed here.

---

## 11. Identity, sessions and access control

### 11.1 Why sessions, not JWTs
The scoring service never needs the learner's identity, so no second service has to verify a user token. Server-side sessions give:
- **Instant revocation** for erasure, deactivation, password change and role change. The JWT design leaves up to 15 minutes.
- **Server-rendered pages with the learner's data.** The server can read an HttpOnly cookie; a token held in browser memory forces every authenticated page to render on the client, which is slower on 3G.
- **Less machinery:** no refresh rotation, no cross-tab refresh race, no signing-key rotation.

What we give up: cookie sessions need CSRF protection, and a future native app or partner API will need bearer tokens added to the identity module.

### 11.2 Session design
- 256 random bits from the OS generator. **Only the SHA-256 hash is stored**, so a database leak yields no usable sessions.
- Cookie `__Host-lm_session`: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, no `Domain`. The `__Host-` prefix blocks sibling subdomains from setting it.
- 7 days idle (sliding), 30 days absolute. `last_seen_at` updates at most every 5 minutes.
- One indexed lookup per request; caching only if measured.
- Logging out everywhere, or changing the password, deletes all of the user's sessions.

### 11.3 CSRF
OWASP treats SameSite as defence in depth, not a replacement for CSRF protection ([cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)). We layer:
1. Same origin only; CORS is off.
2. Unsafe methods require `Content-Type: application/json`.
3. A per-session synchroniser token in `X-CSRF-Token`.
4. `Origin` must match, and `Sec-Fetch-Site` must be `same-origin` or `none` when present.

### 11.4 Credentials and tokens
- argon2id with parameters pinned in code, lowercased emails under a unique index, and verification against a dummy hash when the email is unknown. All three exist in the current code and stay.
- Email verification and password reset tokens: 256 random bits, stored hashed, single use, expiring (24 hours and 30 minutes), rate limited, same response whether or not the account exists.
- Age gate: sign-up records `age_confirmed_at`, no date of birth (PRD §8).
- `@node-rs/argon2` publishes Linux arm64 binaries. CI runs on Arm, so a missing binary in any dependency fails the first pull request.

### 11.5 Authorisation
- Every query on learner data takes `learnerId` from the session, never from input.
- Roles: learner, reviewer, admin (PRD §4.4). Reviewer actions write an append-only `audit_log` row in the same transaction.
- **Isolation tests:** for every route that takes an id, a two-user integration test on a real database.

### 11.6 Rate limiting
`@fastify/rate-limit` (11.2.0) with a Redis store: per IP and per account on auth routes, per user on AI routes, plus a global ceiling. The client IP comes from `CF-Connecting-IP` ([Cloudflare](https://developers.cloudflare.com/fundamentals/reference/http-headers/)), which is trustworthy only because no VM accepts traffic except through the tunnel. Responses are 429 with `Retry-After`.

---

## 12. API conventions

- **One origin.** Everything is served from `app.<domain>`. Tunnel ingress rules match on path: `^/api/.*` to the API, the catch-all to the web app ([Cloudflare](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/)). Server-side rendering calls the API over the internal Docker network and forwards the session cookie.
- All routes sit under `/api/v1/`, in both services. Breaking changes mean `/v2`.
- **Contracts, public side.** Requests, responses, errors and job payloads are zod 4 schemas in `packages/contracts`. Fastify uses `fastify-type-provider-zod` (7.0.0), and `@fastify/swagger` generates OpenAPI from the same schemas.
- **Contracts, scoring side.** FastAPI generates the scoring service's OpenAPI spec, committed as `openapi.json`. `openapi-typescript` generates the api's client types from it. CI regenerates both and fails on any diff, and the end-to-end suite runs the real scoring container with the fake provider.
- **One error envelope:** `{ error: { code, message, details?, requestId } }`, codes defined in `contracts`. `23505` maps to 409; length errors are caught earlier by schema caps matched to the columns.
- **Idempotency keys** on writing submit and purchase, unique per learner.
- **Timeouts everywhere.** Every outbound call has an `AbortSignal` timeout; the api's timeout for scoring calls exceeds the scoring service's model timeout.
- **Keyset pagination** for lists.
- **Health:** `/api/v1/health/live` checks only the process. `/api/v1/health/ready` checks dependencies and runs at deploy time.
- **Streaming (Phase 2 chat):** POST-based server-sent events through the framework's reply object, the request's abort signal passed upstream, and the first byte sent at once, and a heartbeat every 15 seconds. Measured on Cloudflare Free: heartbeats every 15 or 60 seconds delivered every event at most half a second late, and a silence of 125 seconds or more was cut, before the first byte and mid-stream, so the rule is a first byte immediately and never more than 30 seconds of silence ([Cloudflare](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/)).

---

## 13. Integrations

Every external service sits behind an interface with a fake.

| Need | Adapter | Notes |
|---|---|---|
| LLM | OpenAI, from the scoring service | Section 10 |
| Email | Resend | 3,000 a month and **100 a day** free ([pricing](https://resend.com/pricing)); an outbox queue sends verification and reset first |
| Payments | Paystack now, the Cameroon aggregator later | Chosen in PRD Appendix B |
| Object storage | Cloudflare R2 over the S3 API | 10 GB free, free egress ([R2](https://developers.cloudflare.com/r2/pricing/)); buckets per environment plus the private bundle bucket |
| Speech | Behind an interface in the scoring service, Phase 2 | Chosen by the accent audit (PRD §7.3) |
| Errors | Bugsink, self-hosted | Section 16 |

**Payments.**
1. The webhook route verifies the signature over the raw body. For Paystack this is HMAC-SHA512 with the secret key, in `x-paystack-signature`.
2. It inserts into `payment_events`, unique on `(provider, event_id)`, and returns 200 quickly. Paystack retries every 3 minutes four times, then hourly for up to 72 hours.
3. A queued job calls the provider's verify endpoint, then writes the entitlement in one transaction.
4. The price catalogue is data keyed by country, stored in the database, never in the repository.
5. Mobile money cannot renew automatically, so exam-window passes are the primary product (PRD §10.1).

The Paystack details come from secondary sources because its documentation blocks automated fetches; confirm them when implementing.

---

## 14. Web application

- **Next.js 16** on Node 24, `output: 'standalone'`. 16 is Active LTS, and 15 leaves support on 2026-10-21 ([policy](https://nextjs.org/support-policy)), so the app goes from 14 straight to 16.
- **Server components by default.** Pages with learner data fetch on the server with the session cookie. Client components handle interaction only.
- **Performance budget.** First-load JavaScript per route starts capped at 170 KB gzipped, and CI fails when a route grows past its recorded baseline. The current build measures 220 KB on the dashboard. The PRD's target is LCP under 2.5 seconds on a mid-range Android phone over 3G-class links (PRD §11.7).
- **Internationalisation** with `next-intl` (4.14). Interface language is en or fr, independent of the language being learned.
- **PWA.** A manifest plus HTTPS makes the app installable without offline support ([Next.js](https://nextjs.org/docs/app/guides/progressive-web-apps)). Offline mode is a non-goal (PRD §5.2), so there is no service-worker caching at launch.
- **Security headers:** nonce-based CSP with `default-src 'self'`, `connect-src 'self'` and `frame-ancestors 'none'`. LLM output renders as text; a lint rule bans `dangerouslySetInnerHTML`.
- **Logout** revokes the session and clears the query cache.
- **Reviewer console** is a role-gated route group in the same app.
- **Accessibility:** WCAG 2.2 AA; Playwright runs axe on the core journeys.
- **Analytics** are first-party events through the API, never essay text.
- **Browser errors** go to Bugsink through the Sentry SDK's tunnel route on our own origin (section 16).

---

## 15. Security architecture

### 15.1 Trust boundaries

```
 Internet -> Cloudflare (WAF, TLS) -> tunnel -> web, api            [only way in]
 api, worker -> scoring (service token, Docker network)
 api, worker -> Postgres, Redis, R2, Resend, Paystack
 scoring -> OpenAI, R2 (bundle, read-only)
 all app containers -> Bugsink (Oracle private network)
```

- No VM accepts inbound connections from the internet; `cloudflared` dials out. A full TCP scan of the staging server found nothing open.
- Every opened port needs two rules: Oracle's network rule and the host firewall, because Oracle's Ubuntu images end their firewall with a reject rule.
- SSH goes through Cloudflare Access; CI uses a service token with `cloudflared access ssh`, a pinned host key and a pinned connector version (measured on staging: about 4 seconds round trip). Break-glass access when the tunnel is down is an Oracle Bastion session, then the serial console.
- Tailscale is not used; its free plan is non-commercial ([pricing](https://tailscale.com/pricing)).

### 15.2 Threats and controls

| Threat | Controls |
|---|---|
| Credential stuffing | Per-IP and per-account limits, argon2id, generic errors, timing parity |
| Session theft, XSS | HttpOnly `__Host-` cookie, nonce CSP, no token in JavaScript |
| CSRF | Section 11.3 |
| Cross-learner access | `learnerId` from the session only, two-user tests |
| Scoring service misuse | Internal network only, service token, no learner identity, no database |
| LLM cost abuse | Caps in Postgres, rate limits, hard spend limits per environment |
| Score inflation by prompt injection | Fenced input, schema-bound output, server-owned prompts, adversarial gate, same-profile appeals |
| Forged calibration state | Read-only application role on profiles and baselines, fail-closed gate, profile hash checked on every score |
| Prompt and anchor leakage | Private content repository, bundle only in a private bucket, images carry no content |
| Payment forgery | HMAC verification, provider verify call, unique event ids |
| Supply chain | Lockfiles, actions pinned to commit SHAs, Dependabot, CodeQL, `pnpm audit`, `uv` lock, images by digest |
| Leaks through logs or error reports | pino `redact`, `beforeSend` scrubbing in every SDK, tests that fail on essay text in logs |
| Reviewer abuse | Append-only audit log, role separation |

### 15.3 Secrets
- Stored in GitHub Environments (`staging`, `production`). Only jobs that reference an environment can read it, and production requires a reviewer's approval, free on public repositories ([GitHub](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)).
- The deploy writes an env file on the VM with mode 0600. Secrets never appear in images, the repository or logs.
- Each environment has its own database, Redis, OpenAI project, service token, R2 keys and payment credentials. Configuration is validated at boot, and production refuses development values.
- An exposed secret is rotated immediately; rotation has a runbook.

### 15.4 Containers
Non-root users, read-only root filesystems where possible, all capabilities dropped, slim bases (`node:24-slim`, `python:3.14-slim`), images by digest, and a root `.dockerignore` that keeps `.env` and keys out of build contexts.

### 15.5 Data classes

| Class | Examples | Rules |
|---|---|---|
| Restricted | Essays, appeal text, raw model output, anchor essays, later voice | Never logged or sent to error tracking; sent to the LLM without identity; purged on erasure; anchors only in private storage |
| Personal | Email, name, IP, session rows | Shared with third parties only as delivery needs; erased on request |
| Confidential | Prompts, rubrics, prices, calibration data | Private repository or database, never the public repository |
| Internal | Scores without identity, costs | Kept as calibration evidence |
| Public | Calibration statistics we publish | With confidence intervals (PRD §13.6) |

Essays are never added to a calibration or training set without a separate, withdrawable opt-in (PRD §13.3).

---

## 16. Observability and operations

- **Error tracking: Bugsink, self-hosted.** It accepts the official Sentry SDKs ([Bugsink](https://www.bugsink.com/connect-any-application/)), is installed directly on the VM and runs on SQLite (its documentation advises against SQLite on Docker volumes), and its self-hosted edition is free with unlimited users. Its licence is PolyForm Shield 1.0.0, which permits any use except building a product that competes with Bugsink. It runs on one of Oracle's two Always Free AMD VMs (VM.Standard.E2.1.Micro: 1/8 OCPU with burst, 1 GB) ([Oracle](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)), so it survives an app VM failure and uses none of the Arm allowance. Measured: 1,000 stored events peaked at 327 MB with no out-of-memory kill. It accepts but silently drops events beyond 1,000 per 5 minutes per project, so a quiet dashboard does not prove a healthy system; the uptime check covers outages.
  - **Ingestion:** server-side SDKs (api, worker, scoring, the Next.js server) send over Oracle's private network. Browsers send to `/api/v1/monitoring/envelope` on our own origin using the SDK's tunnel option, and the api forwards only envelopes whose project id is on an allow-list, as Sentry's docs require to avoid an open proxy ([Sentry](https://docs.sentry.io/platforms/javascript/guides/nextjs/troubleshooting/#using-the-tunnel-option)).
  - **UI:** `errors.<domain>` behind Cloudflare Access, open to the whole team.
  - **Fallback:** GlitchTip (MIT licence) takes the same SDKs, so switching means changing the DSN. It needs PostgreSQL and 256 to 512 MB ([GlitchTip](https://glitchtip.com/documentation/install)), which makes it the heavier option on a 1 GB VM.
  - Events can carry personal data, so every SDK scrubs with `beforeSend`, and Bugsink's retention is capped.
- **Logs.** pino JSON to stdout, with a `requestId` passed into job payloads and scoring calls; Python logs in the same JSON shape. Docker's `json-file` driver has size and file-count limits. Shipping logs to Grafana Cloud Free (14-day retention, 3 users; [pricing](https://grafana.com/pricing/)) is validated on staging because the agent's memory cost is unmeasured.
- **Uptime.** Grafana synthetic checks from outside Oracle hit the liveness endpoint; alerts go to a shared team channel, so the 3-seat limit only affects who can edit dashboards.
- **Long retention.** Audit and security events (12 months and 3 years, PRD §11.7) are database rows archived to R2.
- **Alerts** (PRD §11.7): queue backlog and oldest-job age, failed jobs, AI error rate, sweeper and backup heartbeats, Neon compute-hours remaining, OpenAI spend.
- **SLO.** 99.5% monthly availability, about 3.6 hours of downtime a month. No redundancy before launch.
- **Time to result.** The PRD's 6-second P95 dates from a very fast provider; we measure on the pinned model, then set the target.
- **VMs are rebuildable.** All state is in Neon, R2 and disposable Redis. The setup script under `infra/staging/` rebuilds a VM, and the drill times it.
- **Runbooks before launch:** incident response, Postgres restore, VM rebuild, secret rotation, release rollback, idle-VM reclaim.
- **Cost guardrails:** a $1 Oracle budget alert, OpenAI hard limits, Neon usage alerts.

---

## 17. Environments and delivery

### 17.1 Environments

| | Local | CI (per pull request) | Staging | Production |
|---|---|---|---|---|
| Database | Postgres 18 in Docker | Postgres 18 service | Neon Free project | Neon, Launch plan at launch |
| Redis | Docker | Service container | On the VM | On the VM |
| Scoring | Container, fake provider, dummy bundle | Same | Real provider, small hard cap, pinned bundle | Real, hard cap, pinned bundle |
| Email | Mailpit | Fake | Resend, allow-listed recipients | Resend |
| Payments | Fake | Fake | Test mode | Live |
| Data | Seed script | Fixtures | Synthetic learners | Real |
| Access | Developer | GitHub | Cloudflare Access (team) | Public |

Production data never leaves production (PRD §11.10).

### 17.2 Machines

| Machine | Shape | Runs |
|---|---|---|
| prod-app | Arm, 1 OCPU, 6 GB (final size set by the sizing gate) | web, api, worker, scoring, redis, cloudflared |
| staging-app | Arm, 1 OCPU, 4 GB | the same, for staging |
| monitoring | AMD micro, 1 GB | Bugsink (installed directly), cloudflared |
| spare | AMD micro, 1 GB | nothing yet |

Small AMD servers exist in only one availability domain of the region. The Arm quotas that apply are the regional ones, not the figures in Oracle's documentation, so the compartment carries an Always Free quota before any server exists.

### 17.3 Standards
1. Environments are isolated, each with its own database, Redis, secrets and keys.
2. **Build once, promote by digest.** CI builds each image once; production deploys the digest staging ran. Content bundles are promoted the same way, by hash.
3. Local and CI need no cloud service.
4. Configuration comes from environment variables, validated at boot.
5. No VM has an open inbound port.
6. Deploys are automated, smoke-tested and reversible; migrations and `content:sync` run first.
7. CI runs on Arm runners, which are free and unlimited on public repositories ([GitHub](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)).

### 17.4 Flow

```
 PR: lint, types, format, unit, integration (real Postgres and Redis), migrations from zero,
     OpenAPI drift check, build all images, boot the stack, end-to-end smoke (fake LLM)
 merge to main -> push images -> staging: migrate, content:sync, compose up --wait, smoke
 tag vX.Y.Z -> approval -> production: same digests, migrate, content:sync, smoke
     -> on failure, redeploy the previous digests
```

Compose over SSH through the tunnel. A restart takes seconds; chat streams reconnect, and in-flight scoring jobs finish in the worker's grace period.

### 17.5 The free stack

| Need | Choice | Free limit | Catch |
|---|---|---|---|
| CI, registry, approvals | GitHub, public repository | Actions, public GHCR packages and environment approvals free | Free only while public. The private content repository gets 2,000 Actions minutes a month, enough for bundle builds |
| App VMs | Oracle Always Free, Arm | 2 OCPU and 12 GB total, 200 GB disk, 10 TB/month out | Idle reclaim risk (see 17.7); allowance cut from 4 OCPU and 24 GB in June 2026; card required; home region permanent |
| Monitoring VM | Oracle Always Free, AMD micro | Two VMs of 1/8 OCPU and 1 GB | Small; Bugsink only |
| Database | Neon Free | 0.5 GB, 100 CU-hours a month, 6-hour history | Compute stops when hours run out; idle free projects deleted after 90 days from 2026-10-05 |
| Edge, tunnel, Access | Cloudflare Free | Zero Trust free to 50 users (search snippet) | 125-second proxy read timeout |
| Files, dumps, bundles | R2 | 10 GB, 1M writes, 10M reads a month | |
| Errors | Bugsink | Unlimited users, self-hosted | We run and back it up |
| Logs, uptime | Grafana Cloud Free | 50 GB logs, 100k checks, 3 users | 14-day retention |
| Email | Resend | 3,000 a month, 100 a day | Tight on a busy day |

Going past the free Oracle size costs about $0.01 per OCPU-hour and $0.0015 per GB-hour (search snippet of Oracle's price list), roughly $14 a month for one extra OCPU and 6 GB.

### 17.6 Domain and hostnames
One registered domain, with Cloudflare nameservers. Start on a free DigitalPlat domain and buy a `.com` (about $10.5 a year at Cloudflare's wholesale price, per secondary sources) before the first outside tester, because free domains can hurt email deliverability.

| Hostname | Purpose | Access |
|---|---|---|
| `app.<domain>` | Production web and API | Public |
| `staging.<domain>` | Staging | Cloudflare Access |
| `errors.<domain>` | Bugsink UI | Cloudflare Access |
| `ssh-prod.`, `ssh-staging.`, `ssh-mon.<domain>` | Deploy and admin SSH | Cloudflare Access |

Hostnames have exactly one label under the domain, because Cloudflare's free certificate covers one level.
| `mail.<domain>` | Resend sending domain | DNS only |
| `<domain>`, `www.<domain>` | Landing page | Public |

### 17.7 Sizing gate and idle reclamation
After the first staging deploy we record memory and CPU per container. Above 70% memory or under sustained CPU load, we investigate, then rebalance the flexible Arm shape before paying for anything.

Oracle treats an Always Free Arm server as idle when CPU (95th percentile), network and memory are all under 20% for 7 days, and may then reclaim it ([Oracle](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)). The base stack alone sits at 12 to 15% of 6 GB, under that line. Decision: staging runs on 4 GB so the full stack stays above it, and Oracle's own memory metric is read over 7 days to confirm. We add no keep-alive load. Production upgrades the account to Pay As You Go before launch and asks Oracle in writing whether that exempts it. We plan as if a reclaimed server is deleted: rebuild from the setup script (163 seconds measured from nothing), or move the Compose stack to another Arm host; state lives outside the servers.

---

## 18. Testing and quality

| Layer | Covers | Runs against | Owner |
|---|---|---|---|
| Unit | Engines, deterministic rules, SRS, readiness, calibration arithmetic; test-first (PRD §11.10) | Nothing external | Code owners |
| Integration | Repositories, routes via `app.inject`, jobs, erasure coverage, two-user isolation | Real Postgres 18 and Redis; scoring faked | Backend |
| Scoring service | Routes, bundle loading and hash checks, provider handling | Fake provider, dummy bundle | AI engineer |
| Contract | zod schemas; OpenAPI drift for the scoring service | Build only | Backend and AI engineer |
| End to end | The six journeys in PRD §8.4, Playwright with axe | Full compose stack, fake LLM | QA |
| Smoke | Register, submit, see a result | Staging after each deploy | QA |
| Scoring regression | Fixed essays through the engine with recorded provider replies | Replay | AI engineer |
| Load | 300 simulated users at the design point, with k6 | Staging, before launch | QA |

- A template database is migrated once and cloned per test worker, so parallel tests never share state.
- Database tests **fail** when no database is configured.
- Vitest 5 and Playwright 1.63 on the TypeScript side; pytest on the Python side. Coverage is reported, not gated, until there is a baseline.
- Prettier for TypeScript, `ruff format` for Python. Strict TypeScript with `noUncheckedIndexedAccess`; strict mypy.
- Required checks on `main`: lint, types, format, tests, migrations from zero, OpenAPI drift, image builds, module boundaries, dependency audit, CodeQL, PR title. Real-model runs are manual and only happen when a profile changes.

---

## 19. Failure modes

| Failure | Learner sees | System behaviour | Recovery |
|---|---|---|---|
| Redis down | Submissions fail with a retry message; login works | Rows stay `submitted`; auth limits fail closed | Restart; the sweeper re-enqueues |
| Scoring service down | "Scoring is taking longer" | Worker retries with backoff, then `failed`; cap not consumed | Restart; sweeper |
| Bundle hash mismatch | Nothing new is scored | Scoring service refuses to start; deploy smoke fails | Fix the pinned hash; previous release keeps running |
| Neon compute exhausted | Maintenance page | Ready check fails, alert | Wait, or move to a paid plan |
| OpenAI outage or 429 | "Scoring is taking longer" | Backoff, then `failed` with reason | Learner retries, or the sweeper does |
| Worker crash mid-job | Nothing | BullMQ requeues; claim guard and idempotent writes prevent double scoring | Automatic |
| Bad release | Brief errors | Smoke fails, previous digests redeployed | Automatic |
| Tunnel down | Site unreachable | Uptime alert | Restart or rebuild the VM |
| App VM lost | Site down | State is elsewhere | `bootstrap.sh`, timed in the drill |
| Monitoring VM lost | Nothing | Error events dropped; app unaffected | Rebuild; SDKs drop events rather than block |
| Duplicate payment webhook | Nothing | Unique event id ignores it | Automatic |
| Email cap reached | Verification delayed | Outbox prioritises verification and reset | Next day |

---

## 20. Rollout of the architecture

This is the platform build order, not the feature roadmap.

**A0. Decisions and spikes.**
- Frank accepts or amends the Proposed decisions in section 4.
- **S1, scoring service contract (2 days, AI engineer or backend):** the stateless `/score` endpoint with OpenAI structured output on a fixture, the generated TypeScript client, and a worker job calling it. Exit when the round trip works end to end with the fake and one real call, and memory and latency are recorded.
- **S2, Oracle VMs (1 day, DevOps), done:** provision the Arm and AMD VMs, run cloudflared, Redis, a hello container and Bugsink; confirm path routing, Access, the private network and a streamed response through Cloudflare.

**A1. Foundation.** Move the worker into `api-gateway`; strip the database from `ai-service`; fresh Kysely initial migration with the scoring-integrity model; platform layer; `packages/contracts`; private content repository and bundle pipeline; CI with Postgres and Redis on Arm, OpenAPI drift, module boundaries and formatting; `CODEOWNERS`; licence file.

**A2. Walking skeleton on staging.** Register, log in, submit an essay, get a fake-LLM score, see the result, deployed by the pipeline with a smoke test, Bugsink and an uptime check.

**A3. Real scoring path.** OpenAI provider, profile registration, calibration harness against the production engine, rate limits, usage caps, erasure. Phase 0a calibration uses this path; essay sourcing starts earlier.

**Effect on existing tickets.** Ticket #53's verdicts change: Python worker rows become "move to TypeScript"; ai-service repository and Alembic rows become "remove"; engine rows stay. The contract ticket between TypeScript and Python (#64) now covers only the scoring API. The service-authentication finding is handled by the service token. Other foundation tickets stand, pointed at this layout.

---

## 21. Licence and intellectual property

- **Decision:** the public repository carries a proprietary licence: copyright reserved, no permission to use, copy or modify granted. Without any licence file the law already reserves all rights, but an explicit file removes doubt for anyone reading the code.
- **What we still get.** Everything this design relies on (free Actions, public GHCR packages, environment approvals, CodeQL, Dependabot, secret scanning) depends on the repository being public, not on its licence. The only programme we lose is Sentry's open-source plan, which requires an MIT- or Apache-style licence ([Sentry](https://sentry.io/for/open-source/)), and Bugsink replaces it.
- **What a licence cannot do.** GitHub's terms let any user view and fork a public repository on GitHub. So nothing confidential goes in the public repository: prompts, rubrics, anchors, prices and calibration data stay private (section 10.3).
- **Third-party code.** Our dependencies use permissive licences. Bugsink's PolyForm Shield allows our use because we do not compete with Bugsink.
- **Team contributions.** Every contributor's contract must assign their work's IP to the company. That is a legal task for Frank, not an engineering control.

---

## 22. Not verified, and open questions

- Memory and CPU of web, worker and scoring, and of the full stack under load. Redis, the tunnel connector and the gateway are measured together (722 and 897 MB); Bugsink is measured (327 MB peak at 1,000 events).
- Whether Pay-As-You-Go stops Oracle reclaiming idle VMs, or keeps the old Arm allowance. No official Oracle page says so; production asks Oracle in writing.
- Whether Oracle stops or deletes a reclaimed server. We plan as if deleted.
- Oracle's idle-account rule (30 days) and how it applies to a paid account.
- Whether UDP is exposed beyond the top 100 ports, which the staging scan covered.
- Email from Oracle to our team: it blocks outbound port 25 by default, so error notifications use a provider reachable over standard web or submission ports.
- Whether an idle connection prevents Neon from suspending.
- The Zero Trust 50-user figure, and how traffic spreads across several tunnel connectors.
- Paystack's webhook details, and whether payment providers accept a free domain.
- DigitalPlat's renewal terms.
- kysely-codegen's maintenance outlook.
- The Grafana agent's memory cost.
- Raw-output retention and Cameroon's transfer rule (counsel).
- The OpenAI model to pin (Phase 0).
- The legal entity name for the licence's copyright line.

**Decisions needed from Frank:** accept or amend the Proposed rows in section 4, especially D4 (sessions instead of JWT), because it changes the PRD's auth text.

---

## 23. Sources

- Next.js support policy: https://nextjs.org/support-policy
- Next.js PWA guide: https://nextjs.org/docs/app/guides/progressive-web-apps
- Neon plans: https://neon.com/pricing and https://neon.com/docs/introduction/plans
- Neon pooling: https://neon.com/docs/connect/connection-pooling
- Neon connection latency: https://neon.com/docs/connect/connection-latency
- Neon Postgres versions: https://neon.com/docs/postgresql/postgres-version-support
- PostgreSQL 18 release notes: https://www.postgresql.org/docs/release/18.0/
- Python release status: https://endoflife.date/python
- BullMQ v5 to v6 migration: https://github.com/taskforcesh/bullmq/blob/master/docs/gitbook/guide/migrations/migrate-from-v5-to-v6.md
- BullMQ PostgreSQL backend: https://github.com/taskforcesh/bullmq/blob/master/docs/gitbook/guide/postgresql.md
- BullMQ going to production: https://github.com/taskforcesh/bullmq/blob/master/docs/gitbook/guide/going-to-production.md
- OpenAI deprecations: https://developers.openai.com/api/docs/deprecations
- OpenAI rate limits: https://developers.openai.com/api/docs/guides/rate-limits
- OpenAI data controls: https://developers.openai.com/api/docs/guides/your-data
- OpenAI project spend limits: https://help.openai.com/en/articles/9186755-managing-your-work-in-the-api-platform-with-projects
- OWASP CSRF prevention: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
- OWASP LLM01 prompt injection: https://genai.owasp.org/llmrisk/llm01-prompt-injection/
- Cloudflare tunnel configuration: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/
- Cloudflare error 524: https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/
- Cloudflare HTTP headers: https://developers.cloudflare.com/fundamentals/reference/http-headers/
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- Oracle Always Free resources: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- GitHub environments: https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments
- GitHub-hosted runners: https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- GitHub Packages billing: https://docs.github.com/en/billing/concepts/product-billing/github-packages
- Bugsink SDK compatibility: https://www.bugsink.com/connect-any-application/
- Bugsink licence: https://github.com/bugsink/bugsink/blob/main/LICENSE
- GlitchTip install: https://glitchtip.com/documentation/install
- Sentry tunnel option: https://docs.sentry.io/platforms/javascript/guides/nextjs/troubleshooting/#using-the-tunnel-option
- Sentry for open source: https://sentry.io/for/open-source/
- Grafana Cloud pricing: https://grafana.com/pricing/
- Resend pricing: https://resend.com/pricing
- Tailscale pricing: https://tailscale.com/pricing
