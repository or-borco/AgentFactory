import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { createLogger } from "@agentfactory/logger";
import type { ModelProvider, RunCredentialContext, RunCredentialStore } from "./run-credentials";

const log = createLogger("model-proxy");

export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;

export interface ModelProviderProfile {
  upstreamBaseUrl: string;
  allowedPaths: ReadonlySet<string>;
  healthPaths: ReadonlySet<string>;
  attachKey: (headers: Record<string, string>, apiKey: string) => void;
}

export const MODEL_PROVIDERS: Record<ModelProvider, ModelProviderProfile> = {
  anthropic: {
    upstreamBaseUrl: "https://api.anthropic.com",
    allowedPaths: new Set(["/v1/messages", "/v1/messages/count_tokens"]),
    healthPaths: new Set(["/api/hello"]),
    attachKey: (headers, apiKey) => {
      headers["x-api-key"] = apiKey;
    },
  },
};

export function modelProxyRoutePrefix(provider: ModelProvider): string {
  return `/${provider}`;
}

const STRIPPED_REQUEST_HEADERS = new Set([
  "host",
  "x-api-key",
  "authorization",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "accept-encoding",
]);

const STRIPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
]);

export interface ModelProxyOptions {
  store: RunCredentialStore;
  resolveCredentials: (
    orgId: number,
    provider: ModelProvider,
  ) => Promise<string | undefined> | string | undefined;
  providers?: Readonly<Record<string, ModelProviderProfile>>;
  maxBodyBytes?: number;
}

class BodyTooLargeError extends Error {}

interface ProviderRoute {
  provider: ModelProvider;
  profile: ModelProviderProfile;
  path: string;
}

function sendError(res: ServerResponse, status: number, type: string, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

export function presentedToken(headers: IncomingHttpHeaders): string | undefined {
  const apiKey = headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey) return apiKey;
  const authorization = headers.authorization;
  const bearer = authorization ? /^Bearer\s+(.+)$/i.exec(authorization) : null;
  return bearer?.[1]?.trim() || undefined;
}

export function routeFor(
  pathname: string,
  providers: Readonly<Record<string, ModelProviderProfile>>,
): ProviderRoute | undefined {
  const match = /^\/([a-z0-9-]+)(\/.*)$/.exec(pathname);
  if (!match) return undefined;
  const provider = match[1]!;
  if (!Object.hasOwn(providers, provider)) return undefined;
  return { provider: provider as ModelProvider, profile: providers[provider]!, path: match[2]! };
}

function forwardedRequestHeaders(
  headers: IncomingHttpHeaders,
  profile: ModelProviderProfile,
  apiKey: string,
): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || STRIPPED_REQUEST_HEADERS.has(name)) continue;
    forwarded[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  profile.attachKey(forwarded, apiKey);
  return forwarded;
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > maxBytes) throw new BodyTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function forward(
  req: IncomingMessage,
  res: ServerResponse,
  route: ProviderRoute,
  apiKey: string,
  search: string,
  maxBodyBytes: number,
): Promise<number> {
  const body = await readBody(req, maxBodyBytes);
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });
  const upstreamBase = route.profile.upstreamBaseUrl.replace(/\/+$/, "");
  const upstream = await fetch(`${upstreamBase}${route.path}${search}`, {
    method: "POST",
    headers: forwardedRequestHeaders(req.headers, route.profile, apiKey),
    body,
    signal: abort.signal,
  });
  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    if (!STRIPPED_RESPONSE_HEADERS.has(name)) headers[name] = value;
  });
  res.writeHead(upstream.status, headers);
  if (!upstream.body) {
    res.end();
    return upstream.status;
  }
  await new Promise<void>((resolve, reject) => {
    const stream = Readable.fromWeb(upstream.body as unknown as WebReadableStream<Uint8Array>);
    stream.on("error", reject);
    res.on("close", resolve);
    stream.pipe(res);
  });
  return upstream.status;
}

function reject(req: IncomingMessage, res: ServerResponse, status: number, type: string, message: string): void {
  req.resume();
  sendError(res, status, type, message);
}

export function createModelProxy(options: ModelProxyOptions): Server {
  const providers = options.providers ?? MODEL_PROVIDERS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return createServer((req, res) => {
    const startedAt = Date.now();
    const url = new URL(req.url ?? "/", "http://model-proxy.local");
    const route = routeFor(url.pathname, providers);

    if (route && route.profile.healthPaths.has(route.path) && (req.method === "HEAD" || req.method === "GET")) {
      req.resume();
      res.writeHead(200);
      res.end();
      return;
    }
    if (!route || req.method !== "POST" || !route.profile.allowedPaths.has(route.path)) {
      log.warn("Model proxy rejected path", { method: req.method, path: url.pathname });
      reject(req, res, 404, "not_found_error", "Not available through the platform model proxy");
      return;
    }

    const context: RunCredentialContext | undefined = options.store.resolve(presentedToken(req.headers));
    if (!context || context.provider !== route.provider) {
      reject(req, res, 401, "authentication_error", "Invalid or expired run credential");
      return;
    }

    void (async () => {
      let status = 0;
      try {
        const apiKey = await options.resolveCredentials(context.orgId, route.provider);
        if (!apiKey) {
          status = 503;
          reject(req, res, 503, "api_error", "No model credential is configured for this organization");
          return;
        }
        status = await forward(req, res, route, apiKey, url.search, maxBodyBytes);
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          status = 413;
          sendError(res, 413, "request_too_large", "Request body exceeds the model proxy limit");
        } else {
          status = 502;
          log.error("Model proxy upstream request failed", { orgId: context.orgId, runId: context.runId, err });
          sendError(res, 502, "api_error", "Upstream model request failed");
        }
      } finally {
        log.info("Model proxy request", {
          orgId: context.orgId,
          runId: context.runId,
          purpose: context.purpose,
          provider: route.provider,
          path: route.path,
          status,
          durationMs: Date.now() - startedAt,
        });
      }
    })();
  });
}
