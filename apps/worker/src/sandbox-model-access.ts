import type { Server } from "node:http";
import { createLogger } from "@agentfactory/logger";
import type { ModelEndpoint } from "./agent-runtime/types";
import { createModelProxy, modelProxyRoutePrefix } from "./model-proxy";
import { RunCredentialStore, type ModelProvider, type RunCredentialContext } from "./run-credentials";

const log = createLogger("sandbox-model-access");

export const MODEL_PROXY_PORT = Number(process.env.MODEL_PROXY_PORT ?? 8787);
export const MODEL_PROXY_BIND = process.env.MODEL_PROXY_BIND ?? "0.0.0.0";
export const MODEL_PROXY_SANDBOX_HOST = process.env.MODEL_PROXY_SANDBOX_HOST ?? "host.docker.internal";

const PLATFORM_KEY_ENV: Record<ModelProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
};

const defaultStore = new RunCredentialStore();

export function resolveCredentials(_orgId: number, provider: ModelProvider): string | undefined {
  const envName = PLATFORM_KEY_ENV[provider];
  return envName ? process.env[envName] || undefined : undefined;
}

export function startModelProxy(store: RunCredentialStore = defaultStore): Promise<Server> {
  const server = createModelProxy({ store, resolveCredentials });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(MODEL_PROXY_PORT, MODEL_PROXY_BIND, () => {
      log.info("Model proxy listening", { bind: MODEL_PROXY_BIND, port: MODEL_PROXY_PORT });
      resolve(server);
    });
  });
}

export interface SandboxModelCredential {
  endpoint: ModelEndpoint;
  revoke: () => void;
}

export function issueSandboxModelCredential(
  context: RunCredentialContext,
  store: RunCredentialStore = defaultStore,
  ttlMs?: number,
): SandboxModelCredential {
  const token = store.issue(context, ttlMs);
  return {
    endpoint: {
      baseUrl: `http://${MODEL_PROXY_SANDBOX_HOST}:${MODEL_PROXY_PORT}${modelProxyRoutePrefix(context.provider)}`,
      token,
    },
    revoke: () => store.revoke(token),
  };
}
