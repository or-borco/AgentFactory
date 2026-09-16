FROM node:22-slim

# git per ARCHITECTURE.md §4's "prebuilt image containing Node, git, and the Agent SDK" — unused
# by this slice (no repo cloning yet) but avoids a second image rebuild when workspace/repo
# support lands.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Cloned repos in /workspace may be managed by npm, pnpm, or yarn — this image only ever had
# npm. `corepack enable` shims pnpm/yarn onto npm's existing native binary (npm itself isn't
# corepack-managed). pnpm is pinned to match this repo's own "packageManager" field
# (pnpm@11.17.0); yarn has no such anchor here, so "stable" tracks Yarn's current release.
# Either shim still transparently fetches whatever exact version a *different* cloned repo
# declares in its own package.json — these `prepare --activate` calls just pre-warm the
# default so the common case doesn't pay a runtime fetch. COREPACK_HOME is shared/world-readable
# so the build-time (root) cache is reusable by the `node` user at runtime.
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable \
    && corepack prepare pnpm@11.17.0 --activate \
    && corepack prepare yarn@stable --activate

WORKDIR /agent
COPY package.json ./
RUN npm install
COPY run-turn-claude.ts ./
COPY generate-repo-map.ts ./

# Non-root: reuse the `node` user node:22-slim already ships (uid 1000) — the worker's
# DockerSandboxProvider never grants this user privileges to escalate.
RUN mkdir -p /workspace && chown -R node:node /workspace /agent /opt/corepack

USER node
WORKDIR /workspace

# Idle keep-alive: the actual agent turn runs as a `docker exec` (see
# docker-sandbox-provider.ts), not as this container's main process, so the same container can
# be exec'd into more than once per session.
CMD ["tail", "-f", "/dev/null"]
