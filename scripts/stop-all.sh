#!/usr/bin/env bash
# Stops the web and worker dev processes (however they were started — `pnpm dev:all`,
# `pnpm dev` / `pnpm dev:worker` separately, or a backgrounded/nohup'd copy of either), then
# tears down the Postgres/Redis containers `dev:all` started — the mirror image of dev-all.sh.
set -uo pipefail
cd "$(dirname "$0")/.."

stopped_any=false

# Matched on the actual command lines observed for this project's processes, not a bare
# "next dev" / "worker" pkill pattern that could also catch an unrelated project on the
# same machine. Covers both the wrapper process and whatever it spawns (tsx watch's own
# child, next dev's next-server), since killing only the wrapper doesn't reliably take
# the child down with it.
PATTERNS=(
  "next/dist/bin/next dev"
  "next-server"
  "tsx watch src/worker\.ts"
  "src/worker\.ts$"
)

for pattern in "${PATTERNS[@]}"; do
  pids=$(pgrep -f "$pattern" || true)
  if [ -n "$pids" ]; then
    echo "Stopping ($pattern): $pids"
    kill $pids 2>/dev/null || true
    stopped_any=true
  fi
done

if [ "$stopped_any" = false ]; then
  echo "Nothing running."
fi

echo "Stopping Postgres/Redis (docker compose down)..."
docker compose down
