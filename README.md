# AgentFactory

AgentFactory is a multi-tenant SaaS where an engineering org creates **agents** (coding + general
purpose), gives them a system prompt, model, skills, and connections (GitHub, Slack/Discord/…,
Jira/Monday/…), and assigns them to **teams** that carry shared context. See [`ARCHITECTURE.md`](./ARCHITECTURE.md)
for the full design and [`CLAUDE.md`](./CLAUDE.md) for repo conventions.

This is a pnpm workspace monorepo:

- **`apps/web`** — Next.js frontend + Route Handler API (auth, orgs, teams, agents, tasks, connections).
- **`apps/worker`** — BullMQ worker that runs agent turns inside a Docker sandbox via the Claude Agent SDK.
- **`packages/core`** — shared domain types.
- **`packages/db`** — Postgres schema, migrations (Drizzle) and repositories.
- **`packages/queue`** — the BullMQ queue definition shared by `apps/web` and `apps/worker`.
- **`packages/shared`** — reusable Tailwind UI primitives.

## Prerequisites

- **Node.js 22+**
- **pnpm** — the repo pins `pnpm@11.17.0` via `packageManager`; run `corepack enable` once and
  `pnpm install` will pick up the right version automatically.
- **Docker** (with Docker Compose) — for local Postgres/Redis, and for the worker's agent sandbox
  containers.
- An **Anthropic API key** — only needed if you want the worker to actually execute agent turns.

## 1. Install dependencies

```bash
pnpm install
```

## 2. Start Postgres and Redis

```bash
docker compose up -d
```

This starts Postgres on `5432` and Redis on `6379` with credentials/database matching the `.env`
examples below (`agentfactory` / `agentfactory` / db `agentfactory`).

## 3. Configure environment variables

Each app/package that needs env vars ships a `.env.example`. Copy them and fill in what's missing:

```bash
cp apps/web/.env.example apps/web/.env.local
cp apps/worker/.env.example apps/worker/.env
```

- `apps/web/.env.local` — Next.js loads this automatically for `next dev`. Defaults already point
  at the Docker Compose Postgres/Redis, so you only need to add the `GITHUB_APP_*` values if you're
  working on the Connections feature (see [GitHub App setup](#github-app-setup) below).
- `apps/worker/.env` — the worker loads this via `dotenv/config` (note: **not** `.env.local`).
  Set `ANTHROPIC_API_KEY` here if you want it to run real agent turns, plus the same
  `GITHUB_APP_*` values as `apps/web` if you're testing repo cloning / PR pushes.

Database/queue scripts (`pnpm --filter @agentfactory/db db:migrate`, `db:seed`, and the test
suites) read `DATABASE_URL`/`REDIS_URL` from your shell environment rather than a package-local
`.env` file. The simplest way to get them there is to export the same values `apps/web/.env.local`
uses, e.g.:

```bash
set -a && source apps/web/.env.local && set +a
```

## 4. Set up the database

```bash
pnpm --filter @agentfactory/db db:migrate
pnpm --filter @agentfactory/db db:seed
```

The seed script creates a demo org and a login you can use immediately:

```
email:    demo@acme.test
password: password
```

## 5. Run the app

```bash
pnpm dev
```

This runs `apps/web` (`next dev`) — open http://localhost:3000 and log in with the demo user above.

### Running the worker (optional — enables real agent execution)

The worker executes agent turns inside a Docker sandbox. To run it locally:

```bash
# Build the sandbox image once (rebuild after changing apps/worker/sandbox-image/*)
docker build -t agentfactory-sandbox:local apps/worker/sandbox-image

pnpm dev:worker
```

Make sure `ANTHROPIC_API_KEY` is set in `apps/worker/.env` and Docker is running. If your Docker
daemon isn't at the default `/var/run/docker.sock` (Colima, Rancher Desktop, etc.), also set
`DOCKER_HOST` — check `docker context ls` for the right socket path.

## GitHub App setup

Needed only if you're working on the **Connections** feature (repo binding, cloning, pushing
branches / opening PRs). Everything else runs fine without it. AgentFactory registers its own
GitHub App via GitHub's manifest flow, so there's no manual form-filling on GitHub's site:

1. With `pnpm dev` running, log in (demo user above) and visit:
   `http://localhost:3000/api/admin/github-app/register`
2. This auto-submits a form to GitHub. Click **Create GitHub App** when GitHub asks you to confirm.
3. GitHub redirects back to `/api/admin/github-app/callback`, which prints the values it just
   created:
   ```
   GITHUB_APP_ID=...
   GITHUB_APP_SLUG=...
   GITHUB_APP_PRIVATE_KEY=...
   ```
4. Copy those three lines into `apps/web/.env.local`. If you're also running the worker (needed
   for repo cloning), copy `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` (not `GITHUB_APP_SLUG`,
   which the worker doesn't need) into `apps/worker/.env` too.
5. Restart `pnpm dev` (and `pnpm dev:worker` if running) so the new env vars are picked up.
6. In the app, go to **Connections** and connect GitHub — this redirects to GitHub's own install
   page (`https://github.com/apps/<slug>/installations/new`) where you pick which repos/org to
   grant access to.

The app is created as a private GitHub App scoped to your local tunnel/host (`origin` of the
request in step 1), so run step 1 against whatever URL you'll actually use — if you later switch
between `localhost:3000` and a tunnel URL, register a new app rather than reusing one.

## Running tests locally

```bash
# Everything (unit → db-integration → queue-integration → e2e), same as CI
pnpm test

# Individually
pnpm test:unit    # vitest, no external services required
pnpm test:db      # vitest, requires Postgres (DATABASE_URL) with migrations applied
pnpm test:queue   # vitest, requires Redis (REDIS_URL)
pnpm test:e2e     # Playwright, requires Postgres + Redis
```

Notes:

- `pnpm test:db` and `pnpm test:queue` need real Postgres/Redis (the `docker compose up -d` from
  step 2 is enough) and the same exported `DATABASE_URL`/`REDIS_URL` described in
  [step 3](#3-configure-environment-variables). Run `pnpm --filter @agentfactory/db db:migrate`
  against whichever database you point `DATABASE_URL` at before running `test:db`.
- **E2E tests** run against a separate `agentfactory_test` database/Redis instance so they never
  touch the data your regular `pnpm dev` session is using. The easiest way to run them headed
  locally is:

  ```bash
  ./scripts/test-e2e-headed.sh
  ```

  This copies `.env.test.example` → `.env.test.local` on first run, creates the
  `agentfactory_test` database if missing, applies migrations, and launches Playwright in headed
  mode. It refuses to run if you already have a `next dev` process up (Next.js only allows one dev
  server per project directory), so stop `pnpm dev` first.
- `pnpm lint` and `pnpm typecheck` run across all packages and are part of CI (see
  `.github/workflows/test.yml`) alongside the four test jobs above.
- A Husky `pre-push` hook runs `pnpm test:unit` automatically; skip it with `git push --no-verify`
  if you really need to.
