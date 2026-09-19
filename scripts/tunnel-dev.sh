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

update_env() {
  local file="$1"
  local url="$2"
  if [ ! -f "$file" ]; then return; fi
  # Escape & so sed doesn't expand it as a backreference in the replacement string
  local url_esc="${url//&/\\&}"
  if grep -q "^PUBLIC_APP_URL=" "$file" 2>/dev/null; then
    sed -i.bak "s|^PUBLIC_APP_URL=.*|PUBLIC_APP_URL=$url_esc|" "$file" && rm -f "$file.bak"
  else
    echo "PUBLIC_APP_URL=$url" >> "$file"
  fi
}

# Runs in a background subshell — does not block pnpm dev:all.
# Quick-tunnel subdomains can take 2–4+ min to propagate to Telegram's DNS servers,
# so we retry indefinitely (every 5s) until setWebhook succeeds, then exit silently.
reregister_telegram_webhooks_bg() {
  local new_url="$1"

  # Strip optional surrounding quotes from .env.local values (e.g. KEY="value")
  local conn_key
  conn_key=$(grep '^CONNECTION_SECRET_KEY=' "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | tr -d '"'"'")
  [ -z "$conn_key" ] && return

  # Query all active Telegram connections
  local rows
  rows=$(docker exec agentfactory-postgres-1 psql -U agentfactory -d agentfactory -t -A -F'|' \
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

    # Retry indefinitely every 5s — DNS propagation can take 2–4+ min.
    # Note: the Telegram API requires the bot token in the URL path, so it is briefly visible
    # in `ps aux` during the curl call. Avoid running this script on shared CI machines.
    local attempt=0 response ok
    while true; do
      attempt=$((attempt + 1))
      response=$(curl -sf -X POST "https://api.telegram.org/bot${bot_token}/setWebhook" \
        -H 'Content-Type: application/json' \
        -d "$payload" 2>/dev/null) || response=""
      ok=$(printf '%s' "$response" | node -e "
        let d='';
        process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(JSON.parse(d||'{}').ok?'yes':'no'));
      " 2>/dev/null) || ok="no"
      if [ "$ok" = "yes" ]; then
        echo "  [Telegram] Webhook registered after ${attempt} attempt(s): $webhook_url"
        break
      fi
      sleep 5
    done
  done <<< "$rows"
}

cleanup() {
  echo ""
  echo "Shutting down..."
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
  reregister_telegram_webhooks_bg "$TUNNEL_URL" &
fi

echo ""
pnpm --dir "$ROOT" dev:all
