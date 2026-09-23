import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { createLogger } from "@agentfactory/logger";
import type { RunCredentialContext, RunCredentialStore } from "./run-credentials";

const log = createLogger("model-proxy");

export const MODEL_PROXY_ALLOWED_PATHS: ReadonlySet<string> = new Set(["/v1/messages", "/v1/messages/count_tokens"]);
export const DEFAULT_UPSTREAM_BASE_URL = "https://api.anthropic.com";
export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;

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
  resolveCredentials: (orgId: number) => Promise<string | undefined> | string | undefined;
  upstreamBaseUrl?: string;
  maxBodyBytes?: number;
}

class BodyTooLargeError extends Error {}

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

function forwardedRequestHeaders(headers: IncomingHttpHeaders, apiKey: string): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || STRIPPED_REQUEST_HEADERS.has(name)) continue;
    forwarded[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  forwarded["x-api-key"] = apiKey;
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
  context: RunCredentialContext,
  apiKey: string,
  url: URL,
  options: Required<Pick<ModelProxyOptions, "upstreamBaseUrl" | "maxBodyBytes">>,
): Promise<number> {
  const body = await readBody(req, options.maxBodyBytes);
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });
  const upstream = await fetch(`${options.upstreamBaseUrl}${url.pathname}${url.search}`, {
    method: "POST",
    headers: forwardedRequestHeaders(req.headers, apiKey),
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
  log.debug("Model proxy stream finished", { orgId: context.orgId, runId: context.runId });
  return upstream.status;
}

export function createModelProxy(options: ModelProxyOptions): Server {
  const settings = {
    upstreamBaseUrl: (options.upstreamBaseUrl ?? DEFAULT_UPSTREAM_BASE_URL).replace(/\/+$/, ""),
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
  };

  return createServer((req, res) => {
    const startedAt = Date.now();
    const url = new URL(req.url ?? "/", "http://model-proxy.local");
    if (req.method !== "POST" || !MODEL_PROXY_ALLOWED_PATHS.has(url.pathname)) {
      req.resume();
      log.warn("Model proxy rejected path", { method: req.method, path: url.pathname });
      sendError(res, 404, "not_found_error", "Not available through the platform model proxy");
      return;
    }

    const context = options.store.resolve(presentedToken(req.headers));
    if (!context) {
      req.resume();
      sendError(res, 401, "authentication_error", "Invalid or expired run credential");
      return;
    }

    void (async () => {
      let status = 0;
      try {
        const apiKey = await options.resolveCredentials(context.orgId);
        if (!apiKey) {
          req.resume();
          status = 503;
          sendError(res, 503, "api_error", "No model credential is configured for this organization");
          return;
        }
        status = await forward(req, res, context, apiKey, url, settings);
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
          path: url.pathname,
          status,
          durationMs: Date.now() - startedAt,
        });
      }
    })();
  });
}
