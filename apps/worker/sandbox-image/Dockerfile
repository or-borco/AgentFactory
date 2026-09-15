FROM node:22-slim

# git per ARCHITECTURE.md §4's "prebuilt image containing Node, git, and the Agent SDK" — unused
# by this slice (no repo cloning yet) but avoids a second image rebuild when workspace/repo
# support lands.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Cloned repos in /workspace are pnpm-managed (root package.json: "packageManager":
# "pnpm@11.17.0"), but this image only ever had npm. COREPACK_HOME is shared/world-readable so
# the pnpm build cached here at build time (as root) is reusable by the `node` user at runtime
# without re-fetching.
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate

WORKDIR /agent
COPY package.json ./
RUN npm install
COPY run-turn.ts ./
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
