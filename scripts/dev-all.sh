#!/usr/bin/env bash
# Runs the full local dev stack: Postgres + Redis (docker compose), then the web app and the
# worker in parallel. Ctrl+C stops the web/worker processes; the db/redis containers keep
# running in the background (same as `docker compose up -d` normally would).
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose up -d --wait

exec pnpm --parallel --filter @agentfactory/web --filter @agentfactory/worker dev
