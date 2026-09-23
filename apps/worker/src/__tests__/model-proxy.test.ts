import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MODEL_PROVIDERS,
  createModelProxy,
  modelProxyRoutePrefix,
  presentedToken,
  routeFor,
  type ModelProviderProfile,
} from "../model-proxy";
import { RunCredentialStore, type ModelProvider, type RunCredentialContext } from "../run-credentials";

interface ReceivedRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const STUB_PROVIDER: string = "stubai";
const stubProvider = STUB_PROVIDER as ModelProvider;

let upstream: Server;
let upstreamUrl: string;
let received: ReceivedRequest[];
let releaseStream: () => void;
let proxy: Server | undefined;
let proxyUrl: string;
let store: RunCredentialStore;

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

function providersWithUpstream(url: string): Record<string, ModelProviderProfile> {
  return {
    anthropic: { ...MODEL_PROVIDERS.anthropic, upstreamBaseUrl: url },
    [STUB_PROVIDER]: {
      upstreamBaseUrl: url,
      allowedPaths: new Set(["/v1/responses"]),
      healthPaths: new Set(),
      attachKey: (headers, apiKey) => {
        headers.authorization = `Bearer ${apiKey}`;
      },
    },
  };
}

async function startProxy(overrides: Partial<Parameters<typeof createModelProxy>[0]> = {}): Promise<void> {
  proxy = createModelProxy({
    store,
    resolveCredentials: (_orgId, provider) => `sk-${provider}-real`,
    providers: providersWithUpstream(upstreamUrl),
    ...overrides,
  });
  proxyUrl = await listen(proxy);
}

function issue(context: Partial<RunCredentialContext> = {}): string {
  return store.issue({ orgId: 7, runId: 42, purpose: "run", provider: "anthropic", ...context });
}

beforeEach(async () => {
  received = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  releaseStream = release;
  upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    received.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
    if (req.headers.accept === "text/event-stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: message_start\ndata: {}\n\n");
      await released;
      res.end("event: message_stop\ndata: {}\n\n");
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "request-id": "req_123" });
    res.end(JSON.stringify({ id: "msg_1", content: [{ type: "text", text: "hi" }] }));
  });
  upstreamUrl = await listen(upstream);
  store = new RunCredentialStore();
  proxy = undefined;
});

afterEach(async () => {
  releaseStream();
  if (proxy) await close(proxy);
  await close(upstream);
});

function post(path: string, token: string | undefined, init: { headers?: Record<string, string>; body?: string } = {}) {
  return fetch(`${proxyUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(token ? { "x-api-key": token } : {}),
      ...init.headers,
    },
    body: init.body ?? JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
  });
}

describe("model proxy", () => {
  it("swaps the run token for the real key and forwards the request unchanged otherwise", async () => {
    await startProxy();
    const token = issue();

    const res = await post("/anthropic/v1/messages?beta=true", token);

    expect(res.status).toBe(200);
    expect(res.headers.get("request-id")).toBe("req_123");
    await expect(res.json()).resolves.toMatchObject({ id: "msg_1" });
    expect(received).toHaveLength(1);
    expect(received[0]!.path).toBe("/v1/messages?beta=true");
    expect(received[0]!.headers["x-api-key"]).toBe("sk-anthropic-real");
    expect(received[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(received[0]!.body).toContain("claude-haiku-4-5");
    expect(JSON.stringify(received[0]!.headers)).not.toContain(token);
  });

  it("accepts the token as a bearer credential and never forwards the authorization header", async () => {
    await startProxy();
    const token = issue({ purpose: "repo-map" });

    const res = await post("/anthropic/v1/messages", undefined, { headers: { authorization: `Bearer ${token}` } });

    expect(res.status).toBe(200);
    expect(received[0]!.headers.authorization).toBeUndefined();
    expect(received[0]!.headers["x-api-key"]).toBe("sk-anthropic-real");
  });

  it("looks up the key for the token's own org and the route's provider", async () => {
    const asked: Array<[number, ModelProvider]> = [];
    await startProxy({
      resolveCredentials: (orgId, provider) => {
        asked.push([orgId, provider]);
        return `sk-org-${orgId}`;
      },
    });

    await post("/anthropic/v1/messages", issue({ orgId: 9 }));

    expect(asked).toEqual([[9, "anthropic"]]);
    expect(received[0]!.headers["x-api-key"]).toBe("sk-org-9");
  });

  it("routes each provider to its own paths and key placement", async () => {
    await startProxy();
    const token = issue({ provider: stubProvider });

    const res = await post("/stubai/v1/responses", undefined, { headers: { authorization: `Bearer ${token}` } });

    expect(res.status).toBe(200);
    expect(received[0]!.path).toBe("/v1/responses");
    expect(received[0]!.headers.authorization).toBe("Bearer sk-stubai-real");
    expect(received[0]!.headers["x-api-key"]).toBeUndefined();
  });

  it("rejects a token on another provider's route", async () => {
    await startProxy();

    const anthropicTokenOnStub = await post("/stubai/v1/responses", issue({ provider: "anthropic" }));
    const stubTokenOnAnthropic = await post("/anthropic/v1/messages", issue({ provider: stubProvider }));

    expect(anthropicTokenOnStub.status).toBe(401);
    expect(stubTokenOnAnthropic.status).toBe(401);
    expect(received).toHaveLength(0);
  });

  it.each([
    ["no credential", undefined],
    ["an unknown token", "arata-run-not-issued"],
    ["the real platform key itself", "sk-anthropic-real"],
  ])("rejects %s without contacting upstream", async (_label, token) => {
    await startProxy();

    const res = await post("/anthropic/v1/messages", token);

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: { type: "authentication_error" } });
    expect(received).toHaveLength(0);
  });

  it("rejects a token once it is revoked", async () => {
    await startProxy();
    const token = issue();
    store.revoke(token);

    expect((await post("/anthropic/v1/messages", token)).status).toBe(401);
    expect(received).toHaveLength(0);
  });

  it.each([
    "/v1/messages",
    "/anthropic/v1/models",
    "/anthropic/v1/complete",
    "/anthropic/v1/messages/batches",
    "/anthropic/api/oauth/profile",
    "/stubai/v1/messages",
    "/openai/v1/responses",
    "/constructor/v1/messages",
    "/anthropic",
    "/",
  ])("refuses %s even with a valid token", async (path) => {
    await startProxy();

    const res = await post(path, issue());

    expect(res.status).toBe(404);
    expect(received).toHaveLength(0);
  });

  it("answers a provider's connectivity check locally, without a credential or an upstream call", async () => {
    await startProxy();

    const head = await fetch(`${proxyUrl}/anthropic/api/hello`, { method: "HEAD" });
    const post = await fetch(`${proxyUrl}/anthropic/api/hello`, { method: "POST" });
    const otherProvider = await fetch(`${proxyUrl}/stubai/api/hello`, { method: "HEAD" });

    expect(head.status).toBe(200);
    expect(post.status).toBe(404);
    expect(otherProvider.status).toBe(404);
    expect(received).toHaveLength(0);
  });

  it("refuses methods other than POST", async () => {
    await startProxy();

    const res = await fetch(`${proxyUrl}/anthropic/v1/messages`, { headers: { "x-api-key": issue() } });

    expect(res.status).toBe(404);
    expect(received).toHaveLength(0);
  });

  it("streams server-sent events through as they arrive", async () => {
    await startProxy();
    const res = await post("/anthropic/v1/messages", issue(), { headers: { accept: "text/event-stream" } });
    const reader = res.body!.getReader();

    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("message_start");
    releaseStream();
    let rest = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain("message_stop");
  });

  it("rejects a body over the size limit without contacting upstream", async () => {
    await startProxy({ maxBodyBytes: 100 });

    const res = await post("/anthropic/v1/messages", issue(), { body: "x".repeat(1000) });

    expect(res.status).toBe(413);
    expect(received).toHaveLength(0);
  });

  it("answers 503 when the org has no model credential", async () => {
    await startProxy({ resolveCredentials: () => undefined });

    const res = await post("/anthropic/v1/messages", issue());

    expect(res.status).toBe(503);
    expect(received).toHaveLength(0);
  });

  it("answers 502 when upstream is unreachable", async () => {
    await startProxy({ providers: providersWithUpstream("http://127.0.0.1:1") });

    const res = await post("/anthropic/v1/messages", issue());

    expect(res.status).toBe(502);
  });
});

describe("routeFor", () => {
  it("splits a provider prefix from the upstream path", () => {
    expect(routeFor("/anthropic/v1/messages", MODEL_PROVIDERS)).toMatchObject({
      provider: "anthropic",
      path: "/v1/messages",
    });
    expect(modelProxyRoutePrefix("anthropic")).toBe("/anthropic");
  });

  it.each(["/v1/messages", "/anthropic", "/unknown/v1/messages", "/toString/v1/messages", "/__proto__/x"])(
    "finds no route for %s",
    (path) => {
      expect(routeFor(path, MODEL_PROVIDERS)).toBeUndefined();
    },
  );
});

describe("presentedToken", () => {
  it("prefers x-api-key and falls back to a bearer authorization header", () => {
    expect(presentedToken({ "x-api-key": "a", authorization: "Bearer b" })).toBe("a");
    expect(presentedToken({ authorization: "bearer  b " })).toBe("b");
    expect(presentedToken({ authorization: "Basic b" })).toBeUndefined();
    expect(presentedToken({})).toBeUndefined();
  });
});
