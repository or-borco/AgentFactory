import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createModelProxy, presentedToken } from "../model-proxy";
import { RunCredentialStore } from "../run-credentials";

interface ReceivedRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let upstream: Server;
let upstreamUrl: string;
let received: ReceivedRequest[];
let releaseStream: () => void;
let proxy: Server;
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

async function startProxy(overrides: Partial<Parameters<typeof createModelProxy>[0]> = {}): Promise<void> {
  proxy = createModelProxy({
    store,
    resolveCredentials: () => "sk-platform-real",
    upstreamBaseUrl: upstreamUrl,
    ...overrides,
  });
  proxyUrl = await listen(proxy);
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
    const token = store.issue({ orgId: 7, runId: 42, purpose: "run" });

    const res = await post("/v1/messages?beta=true", token);

    expect(res.status).toBe(200);
    expect(res.headers.get("request-id")).toBe("req_123");
    await expect(res.json()).resolves.toMatchObject({ id: "msg_1" });
    expect(received).toHaveLength(1);
    expect(received[0]!.path).toBe("/v1/messages?beta=true");
    expect(received[0]!.headers["x-api-key"]).toBe("sk-platform-real");
    expect(received[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(received[0]!.body).toContain("claude-haiku-4-5");
    expect(JSON.stringify(received[0]!.headers)).not.toContain(token);
  });

  it("accepts the token as a bearer credential and never forwards the authorization header", async () => {
    await startProxy();
    const token = store.issue({ orgId: 7, purpose: "repo-map" });

    const res = await post("/v1/messages", undefined, { headers: { authorization: `Bearer ${token}` } });

    expect(res.status).toBe(200);
    expect(received[0]!.headers.authorization).toBeUndefined();
    expect(received[0]!.headers["x-api-key"]).toBe("sk-platform-real");
  });

  it("looks up the key for the token's own org", async () => {
    const orgsAsked: number[] = [];
    await startProxy({
      resolveCredentials: (orgId) => {
        orgsAsked.push(orgId);
        return `sk-org-${orgId}`;
      },
    });

    await post("/v1/messages", store.issue({ orgId: 9, purpose: "run" }));

    expect(orgsAsked).toEqual([9]);
    expect(received[0]!.headers["x-api-key"]).toBe("sk-org-9");
  });

  it.each([
    ["no credential", undefined],
    ["an unknown token", "arata-run-not-issued"],
    ["the real platform key itself", "sk-platform-real"],
  ])("rejects %s without contacting upstream", async (_label, token) => {
    await startProxy();

    const res = await post("/v1/messages", token);

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: { type: "authentication_error" } });
    expect(received).toHaveLength(0);
  });

  it("rejects a token once it is revoked", async () => {
    await startProxy();
    const token = store.issue({ orgId: 7, purpose: "run" });
    store.revoke(token);

    expect((await post("/v1/messages", token)).status).toBe(401);
    expect(received).toHaveLength(0);
  });

  it.each(["/v1/models", "/v1/complete", "/v1/messages/batches", "/api/oauth/profile", "/"])(
    "refuses %s even with a valid token",
    async (path) => {
      await startProxy();

      const res = await post(path, store.issue({ orgId: 7, purpose: "run" }));

      expect(res.status).toBe(404);
      expect(received).toHaveLength(0);
    },
  );

  it("refuses methods other than POST", async () => {
    await startProxy();
    const token = store.issue({ orgId: 7, purpose: "run" });

    const res = await fetch(`${proxyUrl}/v1/messages`, { headers: { "x-api-key": token } });

    expect(res.status).toBe(404);
    expect(received).toHaveLength(0);
  });

  it("streams server-sent events through as they arrive", async () => {
    await startProxy();
    const res = await post("/v1/messages", store.issue({ orgId: 7, purpose: "run" }), {
      headers: { accept: "text/event-stream" },
    });
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

    const res = await post("/v1/messages", store.issue({ orgId: 7, purpose: "run" }), { body: "x".repeat(1000) });

    expect(res.status).toBe(413);
    expect(received).toHaveLength(0);
  });

  it("answers 503 when the org has no model credential", async () => {
    await startProxy({ resolveCredentials: () => undefined });

    const res = await post("/v1/messages", store.issue({ orgId: 7, purpose: "run" }));

    expect(res.status).toBe(503);
    expect(received).toHaveLength(0);
  });

  it("answers 502 when upstream is unreachable", async () => {
    await startProxy({ upstreamBaseUrl: "http://127.0.0.1:1" });

    const res = await post("/v1/messages", store.issue({ orgId: 7, purpose: "run" }));

    expect(res.status).toBe(502);
  });
});

describe("presentedToken", () => {
  it("prefers x-api-key and falls back to a bearer authorization header", () => {
    expect(presentedToken({ "x-api-key": "a", authorization: "Bearer b" })).toBe("a");
    expect(presentedToken({ authorization: "bearer  b " })).toBe("b");
    expect(presentedToken({ authorization: "Basic b" })).toBeUndefined();
    expect(presentedToken({})).toBeUndefined();
  });
});
