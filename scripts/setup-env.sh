#!/usr/bin/env bash
# One-command local env setup: creates the single root .env.local (from .env.example) if it
# doesn't exist yet, auto-generates CONNECTION_SECRET_KEY (the one secret that doesn't need an
# external account — no reason to make anyone run openssl by hand), optionally prompts for
# ANTHROPIC_API_KEY (skippable — only needed to run the worker), and points apps/web/.env.local
# and apps/worker/.env.local at it via symlinks, so Next.js and dotenv/config each keep finding a
# config file exactly where they already look, with only one real file to ever edit.
#
# Safe to re-run: never overwrites an existing root .env.local, and never silently discards an
# existing per-app .env.local that isn't already one of our symlinks — those get backed up instead
# (pre-dating this script, e.g. from before this consolidation), and you're told to fold any values
# only found there into the root file by hand.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_LOCAL=".env.local"
ENV_EXAMPLE=".env.example"

if [ ! -f "$ENV_LOCAL" ]; then
  cp "$ENV_EXAMPLE" "$ENV_LOCAL"
  echo "Created $ENV_LOCAL from $ENV_EXAMPLE."
else
  echo "$ENV_LOCAL already exists — leaving its values as they are."
fi

# Fill in CONNECTION_SECRET_KEY only if it's still the empty placeholder from .env.example — never
# touch a value someone already set (matches ^CONNECTION_SECRET_KEY=$ exactly, not a prefix match,
# so an already-filled-in key is left alone even if it happens to start with the same text).
if grep -qx "CONNECTION_SECRET_KEY=" "$ENV_LOCAL"; then
  key="$(openssl rand -base64 32)"
  # -i.bak rather than bare -i: portable across BSD sed (macOS) and GNU sed (Linux), which disagree
  # on whether -i takes its backup-suffix argument inline or as a separate one.
  sed -i.bak "s|^CONNECTION_SECRET_KEY=\$|CONNECTION_SECRET_KEY=${key}|" "$ENV_LOCAL"
  rm -f "$ENV_LOCAL.bak"
  echo "Generated CONNECTION_SECRET_KEY."
fi

# Offer to fill in ANTHROPIC_API_KEY interactively, same placeholder-only rule as above. Optional
# (only needed to run the worker) and skippable with a bare Enter; skipped automatically when
# stdin isn't a terminal (e.g. piped input, CI) so the script never hangs waiting for a prompt.
if grep -qx "ANTHROPIC_API_KEY=" "$ENV_LOCAL" && [ -t 0 ]; then
  echo ""
  read -r -p "Enter your ANTHROPIC_API_KEY (only needed to run the worker — press Enter to skip): " anthropic_key
  if [ -n "$anthropic_key" ]; then
    sed -i.bak "s|^ANTHROPIC_API_KEY=\$|ANTHROPIC_API_KEY=${anthropic_key}|" "$ENV_LOCAL"
    rm -f "$ENV_LOCAL.bak"
    echo "Saved ANTHROPIC_API_KEY."
  else
    echo "Skipped — you can fill in ANTHROPIC_API_KEY in $ENV_LOCAL later."
  fi
fi

link_env() {
  local app_dir="$1"
  local target="../../$ENV_LOCAL"
  local link_path="$app_dir/$ENV_LOCAL"

  if [ -L "$link_path" ]; then
    # Already a symlink — leave it (whether it points here or somewhere unexpected is not this
    # script's call to make; a developer who hand-rolled something already knows what they did).
    return
  fi

  if [ -e "$link_path" ]; then
    # A real, pre-existing file — likely from before this consolidation. Back it up rather than
    # deleting: it may hold values (a locally-issued GitHub App, a non-default DATABASE_URL) that
    # never made it into the root file.
    local backup="$link_path.pre-consolidation.bak"
    mv "$link_path" "$backup"
    echo "Backed up existing $link_path to $backup — check it for any values not already in $ENV_LOCAL, then remove it."
  fi

  ln -s "$target" "$link_path"
  echo "Linked $link_path -> $target."
}

link_env "apps/web"
link_env "apps/worker"

echo ""
if grep -qx "ANTHROPIC_API_KEY=" "$ENV_LOCAL"; then
  echo "Done. Edit $ENV_LOCAL to fill in GITHUB_APP_* (see README's 'Setting up the GitHub App') and"
  echo "ANTHROPIC_API_KEY if you're running the worker — everything else already has a working default."
else
  echo "Done. Edit $ENV_LOCAL to fill in GITHUB_APP_* (see README's 'Setting up the GitHub App') —"
  echo "everything else already has a working default."
fi
