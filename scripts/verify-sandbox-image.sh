#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

check() {
  local image="$1"
  shift
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    echo "Image '$image' not found - build it first (see scripts/setup-env.sh's ensure_sandbox_image)."
    exit 1
  fi
  echo "-- $image --"
  docker run --rm "$image" bash -c "$*"
}

check arata-sandbox-node:local   'node --version && git --version'
check arata-sandbox-python:local 'node --version && git --version && python3 --version && pip3 --version && pipx --version'
check arata-sandbox-java:local   'node --version && git --version && java --version && mvn --version'

echo "All sandbox images verified."
