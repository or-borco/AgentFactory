# AgentFactory

AgentFactory is a platform for running coding agents against your team's repos. It's a pnpm
workspace monorepo: `apps/web` (Next.js UI + API), `apps/worker` (the process that actually runs
agent turns in a sandboxed Docker container), and shared `packages/*` (domain types, DB access via
Drizzle, a BullMQ-backed queue, and shared UI components).

See `ARCHITECTURE.md` for the full system design and `CLAUDE.md` for repo-specific conventions.

## Prerequisites

- **Node.js 22+**
- **pnpm 11.17.0** (pinned via `packageManager` in `package.json`; use [corepack](https://nodejs.org/api/corepack.html) — `corepack enable` — to pick it up automatically)
- **Docker** — for local Postgres/Redis, and for building the worker's sandbox image
- An **Anthropic API key** — only required if you're running the worker (real agent execution)

## 1. Install dependencies

```bash
pnpm install
```

## 2. Start Postgres and Redis

The repo's `docker-compose.yml` spins up both with the credentials the default env files expect:

```bash
docker compose up -d
```

This starts Postgres on `localhost:5432` (db `agentfactory`, user/password `agentfactory`) and
Redis on `localhost:6379`.

The Postgres image is `pgvector/pgvector:pg16` (stock PostgreSQL 16 plus the `vector` extension,
which the migrations enable). If you have a volume from before that change, recreate it —
`docker compose down -v && docker compose up -d` — then re-run step 4. The image is glibc-based
where the old one was musl, and Postgres cannot detect the collation-provider change on its own.

## 3. Configure environment variables

`apps/web` and `apps/worker` share almost every env var (`DATABASE_URL`, `BLOB_DIR`,
`CONNECTION_SECRET_KEY`, the GitHub App credentials — a document the web app writes has to resolve
to the same place the worker reads it from, a token the web app encrypts has to decrypt the same
way in both processes, and so on), so there's a single `.env.local` at the repo root rather than
one per app. One command sets it up:

```bash
pnpm setup:env
```

This copies `.env.example` to `.env.local` if you don't have one yet, generates
`CONNECTION_SECRET_KEY` for you (a random key, not something you obtain from anywhere — no reason
to make you run `openssl` by hand), and symlinks `apps/web/.env.local` and
`apps/worker/.env.local` to the root file, so both processes keep finding a config file exactly
where they already expect one, with nothing to duplicate or keep in sync. Safe to re-run.

Everything else in the generated file already has a working default (`DATABASE_URL`/`REDIS_URL`
match the `docker-compose.yml` services above, `BLOB_STORE=fs`/`BLOB_DIR=.blobs` needs no
adjustment for local dev). Two things need a value you fill in by hand:

- `GITHUB_APP_ID` / `GITHUB_APP_SLUG` / `GITHUB_APP_PRIVATE_KEY` — only needed for the GitHub
  Connections feature — see [Connecting integrations](#connecting-integrations) below. (Jira
  needs no env vars at all — it's configured entirely through the Connections UI at runtime.)
- `ANTHROPIC_API_KEY` — only needed to run the worker (real agent execution), not to click around
  the web UI.

**Rotating `CONNECTION_SECRET_KEY` orphans every stored credential**: existing `connection_secrets`
rows become undecryptable, and affected users will need to reconnect (re-enter their Jira site
credentials, etc.) before those connections work again.

## 4. Run database migrations and seed data

```bash
pnpm --filter @agentfactory/db db:migrate
pnpm --filter @agentfactory/db db:seed
```

Seeding creates a demo org/team/agents and a login you can use immediately:

```
email:    demo@acme.test
password: password
```

## Running everything at once

```bash
pnpm dev:all
```

Starts Postgres/Redis, runs migrations and seeding, then runs the web app and worker together — a
shortcut for step 2 above and steps 5-6 below. Ctrl+C stops the web/worker processes; Postgres/Redis
keep running in the background.

```bash
pnpm stop:all
```

Stops the web/worker processes (however they were started) and tears down the Postgres/Redis
containers `dev:all` started.

Read on for the individual steps if you'd rather run pieces separately.

## 5. Run the web app

```bash
pnpm dev
```

This runs `next dev` for `@agentfactory/web` at [http://localhost:3000](http://localhost:3000).
Log in with the demo credentials above.

## 6. Run the worker (optional)

The worker is what actually executes an agent turn, inside a sandboxed Docker container. It's not
required to click around the UI mock, but is needed for real runs.

Build the sandbox image it uses (referenced by `SANDBOX_IMAGE` in `.env.local`):

```bash
docker build -t agentfactory-sandbox:local apps/worker/sandbox-image
```

Then start the worker:

```bash
pnpm dev:worker
```

If your Docker daemon isn't at the default `/var/run/docker.sock` (Colima, Rancher Desktop, etc.),
set `DOCKER_HOST` in `.env.local` — check `docker context ls` for the right socket path.

## Connecting integrations

Neither of these is needed to run the app or click around the UI — only for the Connections
feature itself. Each has its own setup doc:

- **[GitHub](docs/setup/github-app.md)** — clone repos and open PRs. Uses a one-time admin route
  that registers a GitHub App for you via its manifest flow; no manual form-filling.
- **[Jira](docs/setup/jira.md)** — link tasks to Jira issues, with attachments pulled in and a PR
  comment written back when a run opens one. Entirely self-service from the Connections UI, no
  admin route needed — just a Jira Cloud API token.

## Running tests

Run everything (matches CI):

```bash
pnpm test
```

This runs, in order, unit tests, DB integration tests, queue integration tests, and E2E tests. You
can also run each suite independently:

```bash
pnpm test:unit    # packages/apps unit tests (vitest, no external deps)
pnpm test:db      # DB repository integration tests — needs Postgres, see below
pnpm test:queue   # queue integration tests — needs Redis, see below
pnpm test:e2e     # Playwright E2E tests against a real running web app
```

`test:db` and `test:queue` need their own scratch Postgres/Redis (separate from the dev database
so tests can freely truncate tables). Copy the root env example once:

```bash
cp .env.test.example .env.test.local
```

The defaults point at the same `docker-compose.yml` Postgres/Redis, but at the
`agentfactory_test` database and Redis db index `1`, so they're safe to run alongside `pnpm dev`.
`test:db` runs its own migrations against that database automatically before each run.

`test:e2e` uses Playwright and needs browsers installed once:

```bash
pnpm --filter @agentfactory/web exec playwright install --with-deps chromium
```

It boots its own `next dev` instance on port 3100 (see `apps/web/playwright.config.ts`), so it
also needs `apps/web/.env.local` configured (step 3) and the test Postgres/Redis running. To watch
the browser instead of running headless, use:

```bash
pnpm test:e2e:headed
```

Other checks used in CI:

```bash
pnpm lint        # eslint across all packages
pnpm typecheck   # tsc --noEmit across all packages
```

### Git hooks

A pre-push hook (via husky) runs `pnpm test:unit` before every `git push`. Skip it for a single
push with `git push --no-verify` if needed.
