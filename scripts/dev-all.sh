#!/usr/bin/env bash
# Runs the full local dev stack: Postgres + Redis (docker compose), migrations, then the web
# app and the worker in parallel. Ctrl+C stops the web/worker processes; the db/redis
# containers keep running in the background (same as `docker compose up -d` normally would) —
# run `pnpm stop:all` to also tear those down.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose up -d --wait

# Matches docker-compose.yml's own service config exactly (the standard local-dev connection
# string documented in apps/web/.env.example and apps/worker/.env.example) — passed explicitly
# rather than relying on a developer's own .env.local, so migrations always target the
# Postgres this script just started regardless of what else might be configured.
DATABASE_URL="postgres://agentfactory:agentfactory@localhost:5432/agentfactory" \
  pnpm --filter @agentfactory/db db:migrate

exec pnpm --parallel --filter @agentfactory/web --filter @agentfactory/worker dev
