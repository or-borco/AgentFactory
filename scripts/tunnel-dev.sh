#!/usr/bin/env bash
# Starts a cloudflared quick-tunnel, updates PUBLIC_APP_URL in .env.local, then runs pnpm dev:all.
# On a new tunnel, automatically re-registers any active Telegram webhooks so the bot keeps working.
#
# Prerequisites: cloudflared, node, curl, docker (for Telegram webhook re-registration)

set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env.local"
WEB_ENV_FILE="$ROOT/apps/web/.env.local"
TUNNEL_LOG=$(mktemp /tmp/cloudflared-XXXXXX.log)
OWN_CLOUDFLARED=0  # 1 only when this script started cloudflared; guards cleanup kill
TUNNEL_REG_PID=""  # PID of the webhook-registration background subshell

update_env() {
  local file="$1"
  local url="$2"
  # Resolve symlinks — macOS sed -i refuses to edit through a symlink
  if [ -L "$file" ]; then
    file="$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$file")"
  fi
  if [ ! -f "$file" ]; then return; fi
  # Read the whole file, replace only the PUBLIC_APP_URL line, write back atomically.
  # This preserves every other variable by construction — no per-variable save/restore needed.
  python3 - "$file" "$url" <<'PYEOF'
import os, sys
file, url = sys.argv[1], sys.argv[2]
with open(file) as f:
    lines = f.readlines()
found = False
out = []
for line in lines:
    if line.startswith('PUBLIC_APP_URL='):
        out.append(f'PUBLIC_APP_URL={url}\n')
        found = True
    else:
        out.append(line)
if not found:
    out.append(f'PUBLIC_APP_URL={url}\n')
tmp = file + '.tmp.' + str(os.getpid())
with open(tmp, 'w') as f:
    f.writelines(out)
os.rename(tmp, file)
PYEOF
}

# Resolves the postgres container name from docker-compose so the script works regardless
# of which directory the repo was cloned into (Docker Compose names containers
# <project-name>-<service>-N, where project name defaults to the directory name).
postgres_container() {
  docker compose -f "$ROOT/docker-compose.yml" ps -q postgres 2>/dev/null \
    | xargs -r docker inspect --format '{{.Name}}' 2>/dev/null \
    | sed 's|^/||' \
    | head -1
}

# Runs in a background subshell — does not block pnpm dev:all.
# Quick-tunnel subdomains can take 2–4+ min to propagate to Telegram's DNS servers,
# so we retry every 5s until setWebhook succeeds. Breaks immediately on HTTP 401 (bad
# token) rather than looping forever.
reregister_telegram_webhooks_bg() {
  local new_url="$1"

  # Strip optional surrounding quotes from .env.local values (e.g. KEY="value")
  local conn_key
  conn_key=$(grep '^CONNECTION_SECRET_KEY=' "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | tr -d '"'"'")
  [ -z "$conn_key" ] && return

  local container
  container=$(postgres_container)
  [ -z "$container" ] && return

  # Query all active Telegram connections
  local rows
  rows=$(docker exec "$container" psql -U agentfactory -d agentfactory -t -A -F'|' \
    -c "SELECT cs.ciphertext, c.config->>'webhookSecret', c.config->>'telegramSecretToken' \
        FROM connections c \
        JOIN connection_secrets cs ON cs.id = c.credential_ref \
        WHERE c.provider='telegram' AND c.health='healthy';" 2>/dev/null) || return
  [ -z "$rows" ] && return

  while IFS='|' read -r ciphertext webhook_secret tg_secret; do
    [ -z "$ciphertext" ] && continue

    # Decrypt the bot token via Node.js AES-256-GCM (key passed via env var, not shell arg,
    # to avoid exposing it in the process list)
    local bot_token
    bot_token=$(CIPHERTEXT="$ciphertext" CONN_KEY="$conn_key" node -e "
      const { createDecipheriv } = require('crypto');
      const envelope = Buffer.from(process.env.CIPHERTEXT, 'base64');
      const key = Buffer.from(process.env.CONN_KEY, 'base64');
      const iv = envelope.subarray(0, 12);
      const authTag = envelope.subarray(12, 28);
      const encrypted = envelope.subarray(28);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      process.stdout.write(JSON.parse(decrypted.toString()).botToken || '');
    " 2>/dev/null) || continue
    [ -z "$bot_token" ] && continue

    local webhook_url="$new_url/api/webhooks/telegram/$webhook_secret"

    # Build JSON safely to avoid injection if secrets ever contain special characters
    local payload
    payload=$(WEBHOOK_URL="$webhook_url" TG_SECRET="$tg_secret" node -e "
      process.stdout.write(JSON.stringify({
        url: process.env.WEBHOOK_URL,
        secret_token: process.env.TG_SECRET
      }));
    " 2>/dev/null) || continue

    # Retry every 5s — DNS propagation can take 2–4+ min. Breaks immediately on HTTP 401
    # (invalid bot token) rather than looping forever.
    # Note: the Telegram API requires the bot token in the URL path, so it is briefly visible
    # in `ps aux` during the curl call. Avoid running this script on shared CI machines.
    local attempt=0 response ok error_code
    while true; do
      attempt=$((attempt + 1))
      response=$(curl -sf -X POST "https://api.telegram.org/bot${bot_token}/setWebhook" \
        -H 'Content-Type: application/json' \
        -d "$payload" 2>/dev/null) || response=""
      ok=$(printf '%s' "$response" | node -e "
        let d='';
        process.stdin.on('data',c=>d+=c).on('end',()=>{
          const r=JSON.parse(d||'{}');
          process.stdout.write(r.ok?'yes':'no');
        });
      " 2>/dev/null) || ok="no"
      if [ "$ok" = "yes" ]; then
        echo "  [Telegram] Webhook registered after ${attempt} attempt(s): $webhook_url"
        # Register slash commands so they appear in Telegram's autocomplete menu (best-effort).
        curl -sf -X POST "https://api.telegram.org/bot${bot_token}/setMyCommands" \
          -H 'Content-Type: application/json' \
          -d '{"commands":[{"command":"tasks","description":"Show your tasks and start a new one"},{"command":"start","description":"Show your tasks and start a new one"}]}' \
          >/dev/null 2>&1 || true
        break
      fi
      # 401 = bad token; retrying won't help
      error_code=$(printf '%s' "$response" | node -e "
        let d='';
        process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(String(JSON.parse(d||'{}').error_code||'')));
      " 2>/dev/null) || error_code=""
      if [ "$error_code" = "401" ]; then
        echo "  [Telegram] Webhook registration failed: bot token invalid (401). Skipping." >&2
        break
      fi
      sleep 5
    done
  done <<< "$rows"
}

cleanup() {
  echo ""
  echo "Shutting down..."
  if [ -n "$TUNNEL_REG_PID" ]; then
    kill "$TUNNEL_REG_PID" 2>/dev/null || true
  fi
  if [ "$OWN_CLOUDFLARED" = "1" ]; then
    kill "$TUNNEL_PID" 2>/dev/null || true
  fi
  rm -f "$TUNNEL_LOG"
}
trap cleanup EXIT INT TERM

EXISTING_URL=""
if pgrep -x cloudflared >/dev/null 2>&1; then
  echo "cloudflared already running, reading existing tunnel URL from .env.local..."
  EXISTING_URL=$(grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' "$ENV_FILE" 2>/dev/null | head -1 || true)
fi

if [ -n "$EXISTING_URL" ]; then
  TUNNEL_URL="$EXISTING_URL"
  TUNNEL_PID=$(pgrep -x cloudflared | head -1)
  # Verify the reused URL is still reachable; warn if not
  if ! curl -sf --max-time 5 "$TUNNEL_URL" -o /dev/null 2>/dev/null; then
    echo "Warning: existing tunnel URL $TUNNEL_URL is not reachable."
    echo "Kill cloudflared and re-run this script to get a fresh tunnel."
  fi
  echo "Reusing tunnel: $TUNNEL_URL"
else
  cloudflared tunnel --url http://localhost:3000 >"$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!
  OWN_CLOUDFLARED=1

  echo "Waiting for tunnel URL..."
  TUNNEL_URL=""
  for i in $(seq 1 30); do
    TUNNEL_URL=$(grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1 || true)
    if [ -n "$TUNNEL_URL" ]; then break; fi
    # Bail early if cloudflared exited unexpectedly
    if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
      echo "Error: cloudflared exited unexpectedly. Output:"
      cat "$TUNNEL_LOG"
      exit 1
    fi
    sleep 1
  done

  if [ -z "$TUNNEL_URL" ]; then
    echo "Error: timed out waiting for tunnel URL. cloudflared output:"
    cat "$TUNNEL_LOG"
    exit 1
  fi

  echo "Tunnel live: $TUNNEL_URL"
  update_env "$ENV_FILE" "$TUNNEL_URL"
  update_env "$WEB_ENV_FILE" "$TUNNEL_URL"
  echo "Updated PUBLIC_APP_URL in .env.local"

  echo "Re-registering Telegram webhooks in background (DNS propagation can take a few minutes)..."
  TUNNEL_REG_LOG=$(mktemp) || TUNNEL_REG_LOG=/tmp/tunnel-reg-$$.log
  reregister_telegram_webhooks_bg "$TUNNEL_URL" >"$TUNNEL_REG_LOG" 2>&1 &
  TUNNEL_REG_PID=$!
  # Print registration output once it finishes (runs alongside pnpm dev:all)
  { wait "$TUNNEL_REG_PID" 2>/dev/null; cat "$TUNNEL_REG_LOG"; rm -f "$TUNNEL_REG_LOG"; } &
fi

echo ""
pnpm --dir "$ROOT" dev:all
