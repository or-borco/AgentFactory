# AgentFactory

A monorepo for running agentic coding tasks against your team's repos: a Next.js web app for
managing orgs/teams/agents/tasks, a worker that executes agent turns inside sandboxed Docker
containers, and shared packages for domain types, the Postgres data layer, and the job queue.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full system design and [CLAUDE.md](./CLAUDE.md)
for repo conventions.

## Prerequisites

- Node.js >= 22 (see `engines` in `package.json`)
- [pnpm](https://pnpm.io/) 11 (`corepack enable` will pick up the version pinned in `packageManager`)
- Docker (for local Postgres/Redis via `docker-compose.yml`, and for the worker's sandbox containers)

## 1. Run the app locally

```bash
# Install dependencies (also sets up the husky git hooks via the "prepare" script)
pnpm install

# Start Postgres + Redis
docker compose up -d
```

### Configure environment variables

Each app reads its own `.env.local` (git-ignored). Copy the example files and fill in dev
defaults:

```bash
cp apps/web/.env.example apps/web/.env.local
cp apps/worker/.env.example apps/worker/.env.local
```

- `apps/web/.env.local` — needs `DATABASE_URL` and `REDIS_URL` (the example defaults already
  match `docker-compose.yml`). `GITHUB_APP_*` is only required for the Connections feature —
  see [Setting up the GitHub App](#2-setting-up-the-github-app-optional) below.
- `apps/worker/.env.local` — needs `DATABASE_URL`, `REDIS_URL`, and `ANTHROPIC_API_KEY` to run
  real agent turns. `GITHUB_APP_*` is the same app as `apps/web` (the worker mints its own repo
  clone tokens). `SANDBOX_IMAGE` must point at an image built locally (see below).

### Set up the database

```bash
pnpm --filter @agentfactory/db db:migrate
pnpm --filter @agentfactory/db db:seed
```

Seeding creates a demo org/team/agents and a login you can use immediately:

```
email:    demo@acme.test
password: password
```

### Run the web app

```bash
pnpm dev
# -> http://localhost:3000
```

### Run the worker (optional, for real agent execution)

The worker executes agent turns inside a Docker sandbox container, so build that image first:

```bash
docker build -t agentfactory-sandbox:local apps/worker/sandbox-image
pnpm dev:worker
```

If your Docker daemon isn't at the default `/var/run/docker.sock` (e.g. Colima, Rancher
Desktop), set `DOCKER_HOST` in `apps/worker/.env.local` — check `docker context ls` for the
right socket path.

## 2. Setting up the GitHub App (optional)

Only needed if you want to exercise the Connections feature (linking a GitHub org/repo to a
team so agents can clone and open PRs against it). Skip this if you're just working on
unrelated parts of the app.

The app is registered once per environment via GitHub's manifest flow, so there's no manual
form-filling on GitHub's site:

1. Start the web app and log in (`pnpm dev`, then sign in as `demo@acme.test`).
2. Visit `http://localhost:3000/api/admin/github-app/register`. This auto-submits a form to
   GitHub with a manifest describing the app's permissions (`contents:write`,
   `pull_requests:write`, `metadata:read`).
3. On GitHub, confirm creation of the app under your account.
4. GitHub redirects back to `/api/admin/github-app/callback`, which exchanges the one-time code
   for real credentials and prints them as plain text:
   ```
   GITHUB_APP_ID=...
   GITHUB_APP_SLUG=...
   GITHUB_APP_PRIVATE_KEY=...
   ```
5. Copy those three values into **both** `apps/web/.env.local` and `apps/worker/.env.local`
   (same app, both processes need it), then restart `pnpm dev` / `pnpm dev:worker`.
6. In the app, go to `/connections` and install the GitHub App on the account/org whose repos
   you want to use. GitHub redirects to `/api/connections/github/callback`, which records the
   installation as a `Connection` for your org.

Installation tokens are minted on demand and never persisted — only the app id/private key are
stored in env vars.

## 3. Running tests locally

There's no single test runner — different suites need different local infra. Run them all with:

```bash
pnpm test
```

Or individually:

| Command | What it covers | Requires |
| --- | --- | --- |
| `pnpm test:unit` | Unit tests (`vitest --project unit`) across all packages | Nothing extra |
| `pnpm test:db` | `packages/db` repository tests against a real Postgres | A scratch Postgres DB (see below) |
| `pnpm test:queue` | `packages/queue` tests against a real Redis | A scratch Redis instance (see below) |
| `pnpm test:e2e` | Playwright end-to-end tests for `apps/web` | Postgres + Redis (starts its own `next dev` server) |

### Setting up `test:db` / `test:queue` / `test:e2e`

These need a **scratch** Postgres database and Redis instance, separate from your dev ones (the
db tests truncate all tables between test files). The simplest option is another database on
the same `docker-compose.yml` Postgres container:

```bash
docker compose exec postgres createdb -U agentfactory agentfactory_test
```

Then copy the test env example and point it at that scratch DB/Redis:

```bash
cp .env.test.example .env.test.local
```

The defaults in `.env.test.example` already match the `docker-compose.yml` container
(`agentfactory_test` database on the same Postgres, Redis logical DB `1`). This file is
auto-loaded by the test setup files (`packages/db/src/__tests__/setup.ts`,
`packages/queue/src/__tests__/setup.ts`) and is a no-op in CI, where `DATABASE_URL`/`REDIS_URL`
are already set by the workflow (`.github/workflows/test.yml`).

`pnpm test:db` runs its own migrations against `.env.test.local`'s database automatically.
`pnpm test:e2e` additionally needs the migrations applied once up front, and the Playwright
browser installed the first time:

```bash
DATABASE_URL=postgres://agentfactory:agentfactory@localhost:5432/agentfactory_test \
  pnpm --filter @agentfactory/db db:migrate
pnpm --filter @agentfactory/web exec playwright install --with-deps chromium
```

### Other checks

```bash
pnpm lint       # eslint across all packages
pnpm typecheck  # tsc --noEmit across all packages
pnpm build      # build all packages
```
