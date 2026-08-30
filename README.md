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

Copy the example env files and fill them in:

```bash
cp apps/web/.env.example apps/web/.env.local
cp apps/worker/.env.example apps/worker/.env.local
```

- `apps/web/.env.local` — needs `DATABASE_URL` and `REDIS_URL` (the defaults already match the
  `docker-compose.yml` services above, so they usually work as-is). `GITHUB_APP_ID`,
  `GITHUB_APP_SLUG`, and `GITHUB_APP_PRIVATE_KEY` are only needed for the Connections feature —
  see [Setting up the GitHub App](#setting-up-the-github-app) below.
- `apps/worker/.env.local` — same `DATABASE_URL`/`REDIS_URL`, plus `ANTHROPIC_API_KEY` and the
  same `GITHUB_APP_ID`/`GITHUB_APP_PRIVATE_KEY` as the web app (the worker mints its own GitHub
  clone tokens directly). Also sets `SANDBOX_IMAGE`, used in step 6.

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

## 5. Run the web app

```bash
pnpm dev
```

This runs `next dev` for `@agentfactory/web` at [http://localhost:3000](http://localhost:3000).
Log in with the demo credentials above.

## 6. Run the worker (optional)

The worker is what actually executes an agent turn, inside a sandboxed Docker container. It's not
required to click around the UI mock, but is needed for real runs.

Build the sandbox image it uses (referenced by `SANDBOX_IMAGE` in `apps/worker/.env.local`):

```bash
docker build -t agentfactory-sandbox:local apps/worker/sandbox-image
```

Then start the worker:

```bash
pnpm dev:worker
```

If your Docker daemon isn't at the default `/var/run/docker.sock` (Colima, Rancher Desktop, etc.),
set `DOCKER_HOST` in `apps/worker/.env.local` — check `docker context ls` for the right socket path.

## Setting up the GitHub App

Connections to GitHub (cloning repos, opening PRs) go through a single GitHub App shared by the
web app and worker. Rather than hand-filling GitHub's app-creation form, the repo has a one-time
admin route that uses GitHub's manifest flow to create it for you:

1. Start the web app (`pnpm dev`) and log in (the seeded `demo@acme.test` user works; the route
   just requires an authenticated session, no separate admin role today).
2. Visit [http://localhost:3000/api/admin/github-app/register](http://localhost:3000/api/admin/github-app/register).
   This redirects to GitHub with a pre-filled app manifest (name, permissions, callback URLs)
   and asks you to confirm creation.
3. After confirming, GitHub redirects back to the app's callback route, which exchanges the
   one-time code for real credentials and prints them out.
4. Copy the printed values into **both** `apps/web/.env.local` and `apps/worker/.env.local`:
   ```
   GITHUB_APP_ID=...
   GITHUB_APP_SLUG=...          # web only
   GITHUB_APP_PRIVATE_KEY=...
   ```
5. Restart the dev server(s) so the new env vars are picked up.
6. Install the app on the GitHub org/repos you want to connect from the org's Connections page in
   the UI (or from the app's settings page on GitHub directly).

Because this registers a real (unlisted) GitHub App tied to whatever origin you ran it from, doing
this against `http://localhost:3000` is fine for local dev — you'll just re-run it if your local
URL ever changes.

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
