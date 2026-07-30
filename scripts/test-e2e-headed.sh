#!/usr/bin/env bash
# Runs the Playwright E2E suite in headed mode against a scratch Postgres/Redis, without
# touching the databases apps/web/.env.local points your regular `pnpm dev` at.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env.test.local ]; then
  cp .env.test.example .env.test.local
  echo "Created .env.test.local from .env.test.example"
fi

set -a
source .env.test.local
set +a

# Next.js refuses to start a second `next dev` for the same project directory regardless of
# port, so Playwright's own webServer won't boot if your normal dev server is still up.
if pgrep -f "next dev" >/dev/null 2>&1; then
  echo "Error: a 'next dev' process is already running. Next.js only allows one per project" >&2
  echo "directory, regardless of port, so Playwright's own server can't start." >&2
  echo "Stop it first (find it with: pgrep -fl 'next dev'), then re-run this script." >&2
  exit 1
fi

if ! docker compose exec -T postgres psql -U agentfactory -d agentfactory -tc \
  "SELECT 1 FROM pg_database WHERE datname = 'agentfactory_test'" | grep -q 1; then
  echo "Creating agentfactory_test database..."
  docker compose exec -T postgres psql -U agentfactory -d agentfactory -c "CREATE DATABASE agentfactory_test"
fi

pnpm --filter @agentfactory/db db:migrate
pnpm --filter @agentfactory/web exec playwright test --headed "$@"
