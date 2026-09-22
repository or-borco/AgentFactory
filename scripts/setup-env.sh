#!/usr/bin/env bash
# One-command local env setup: installs any missing prerequisite tooling (Node.js, pnpm, Docker),
# creates the single root .env.local (from .env.example) if it doesn't exist yet, auto-generates
# CONNECTION_SECRET_KEY (the one secret that doesn't need an external account — no reason to make
# anyone run openssl by hand), optionally prompts for ANTHROPIC_API_KEY (skippable — only needed to
# run the worker), and points apps/web/.env.local and apps/worker/.env.local at it via symlinks, so
# Next.js and dotenv/config each keep finding a config file exactly where they already look, with
# only one real file to ever edit.
#
# Run directly (./scripts/setup-env.sh), not via `pnpm setup:env` — this script is what gets pnpm
# itself installed if it's missing, so a pnpm-based entry point would be chicken-and-egg.
#
# Safe to re-run: never overwrites an existing root .env.local, and never silently discards an
# existing per-app .env.local that isn't already one of our symlinks — those get backed up instead
# (pre-dating this script, e.g. from before this consolidation), and you're told to fold any values
# only found there into the root file by hand. Tooling installs are likewise skipped whenever the
# tool is already on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."

have() { command -v "$1" >/dev/null 2>&1; }
os="$(uname -s)"

# Node.js — needed for corepack (which provides pnpm) and for everything else in the repo.
# No good non-interactive way to install a specific Node major version without a version manager
# already present, so this sticks to Homebrew (macOS) and apt (Debian/Ubuntu) and otherwise just
# points at the manual install docs.
ensure_node() {
  if have node; then
    return
  fi
  echo "Node.js not found."
  if [ "$os" = "Darwin" ] && have brew; then
    echo "Installing Node.js via Homebrew..."
    brew install node
  elif [ "$os" = "Linux" ] && have apt-get; then
    echo "Installing Node.js 22.x via NodeSource..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  else
    echo "Install Node.js 22+ manually: https://nodejs.org/"
    exit 1
  fi
}

# pnpm — pinned to the version in package.json's "packageManager" field via corepack, which ships
# with Node.js itself, so this always prefers corepack over a bare `npm install -g pnpm`.
ensure_pnpm() {
  if have pnpm; then
    return
  fi
  echo "pnpm not found."
  if have corepack; then
    echo "Enabling pnpm via corepack..."
    corepack enable
    corepack prepare pnpm@11.17.0 --activate
  elif have npm; then
    echo "corepack unavailable — installing pnpm via npm instead..."
    npm install -g pnpm@11.17.0
  else
    echo "Install Node.js 22+ (which includes corepack) first: https://nodejs.org/"
    exit 1
  fi
}

# Docker — for local Postgres/Redis and the worker's sandbox image. Docker Desktop (macOS) needs a
# one-time manual launch to finish onboarding and start the daemon; this only gets it onto disk.
ensure_docker() {
  if have docker; then
    return
  fi
  echo "Docker not found."
  if [ "$os" = "Darwin" ] && have brew; then
    echo "Installing Docker Desktop via Homebrew..."
    brew install --cask docker
    echo "Docker Desktop installed — open it once from Applications to finish setup and start the daemon."
  elif [ "$os" = "Linux" ] && have apt-get; then
    echo "Installing Docker via the official convenience script..."
    curl -fsSL https://get.docker.com | sh
    echo "Docker installed — you may need to log out/in (or run 'newgrp docker') for group membership to take effect."
  else
    echo "Install Docker manually: https://docs.docker.com/get-docker/"
    exit 1
  fi
}

# The worker's sandbox images — built from the repo's own multi-stage Dockerfile, no external
# inputs, so this can just build them non-interactively like everything else here. Each tag is
# skipped independently if already present (same idempotent pattern as ensure_docker) since a
# rebuild after every edit to sandbox-image/ is the developer's call, not this script's.
ensure_sandbox_image() {
  if ! have docker; then
    return
  fi
  build_sandbox_target() {
    local target="$1" tag="$2"
    if docker image inspect "$tag" >/dev/null 2>&1; then
      return
    fi
    echo "Building $tag (needed to run the worker)..."
    docker build --target "$target" -t "$tag" apps/worker/sandbox-image
  }
  build_sandbox_target node arata-sandbox-node:local
  build_sandbox_target python arata-sandbox-python:local
  build_sandbox_target java arata-sandbox-java:local
}

ensure_node
ensure_pnpm
ensure_docker
ensure_sandbox_image

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
