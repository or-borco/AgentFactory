#!/usr/bin/env bash
# Runs the Playwright E2E suite against a scratch Postgres/Redis, without touching the databases
# apps/web/.env.local points your regular `pnpm dev` at. Pass --headed to watch the browser.
set -euo pipefail
cd "$(dirname "$0")/.."

headed=false
args=()
for arg in "$@"; do
  if [ "$arg" = "--headed" ]; then
    headed=true
  else
    args+=("$arg")
  fi
done

# In CI, DATABASE_URL/REDIS_URL are already set by the job (see .github/workflows/test.yml) and
# Postgres runs as a GitHub Actions service, not via docker-compose, so this whole local-only
# bootstrap is skipped there.
if [ -z "${CI:-}" ]; then
  if [ ! -f .env.test.local ]; then
    cp .env.test.example .env.test.local
    echo "Created .env.test.local from .env.test.example"
  fi

  set -a
  source .env.test.local
  set +a

  if ! docker compose exec -T postgres psql -U agentfactory -d agentfactory -tc \
    "SELECT 1 FROM pg_database WHERE datname = 'agentfactory_test'" | grep -q 1; then
    echo "Creating agentfactory_test database..."
    docker compose exec -T postgres psql -U agentfactory -d agentfactory -c "CREATE DATABASE agentfactory_test"
  fi
fi

# Next.js refuses to start a second `next dev` for the same project directory regardless of
# port, so Playwright's own webServer won't boot if your normal dev server is still up.
if pgrep -f "next dev" >/dev/null 2>&1; then
  echo "Error: a 'next dev' process is already running. Next.js only allows one per project" >&2
  echo "directory, regardless of port, so Playwright's own server can't start." >&2
  echo "Stop it first (find it with: pgrep -fl 'next dev'), then re-run this script." >&2
  exit 1
fi

pnpm --filter @agentfactory/db db:migrate

if [ "$headed" = true ]; then
  pnpm --filter @agentfactory/web exec playwright test --headed "${args[@]:-}"
else
  pnpm --filter @agentfactory/web exec playwright test "${args[@]:-}"
fi
