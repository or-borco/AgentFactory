import { describe, expect, it, vi, beforeEach } from "vitest";
import "@agentfactory/db/src/__tests__/setup.js";
import { insertOrg, insertAgent, insertUser, insertMembership } from "@agentfactory/db/src/__tests__/fixtures.js";
import {
  createConnection,
  createConnectionSecret,
  generateInviteCode,
  getAuthorizationStatus,
  authorizeExternalUser,
  revokeAuthorizedUser,
  listMessages,
  findSessionByExternalThread,
  getRunsForSession,
} from "@agentfactory/db";
// Namespace import alongside the named one above so individual repository functions can be
// spied on for the "an internal error must never surface as a non-200" regression test — this
// route test deliberately runs against the real @agentfactory/db (see the file-level note in
// task-10-brief.md), so simulating a transient failure means stubbing one real export, not
// swapping in a mock module.
import * as db from "@agentfactory/db";
import { POST } from "../[webhookSecret]/route";

// The adapter's own send()/sendMenu()/sendTyping() hit the real Telegram API — stubbed here so
// these tests exercise only this route's orchestration. receive() stays real (backed by the
// actual TelegramChannelAdapter, already covered independently by Task 7's adapter tests) so the
// update-shape parsing in these tests is exercised for real, not re-mocked. The three send mocks
// are hoisted to module scope (not created fresh inside the factory) so tests can assert on what
// was actually sent back to the chat, not just on side effects in the database.
const { mockSend, mockSendMenu, mockSendTyping } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockSendMenu: vi.fn(),
  mockSendTyping: vi.fn(),
}));
vi.mock("@agentfactory/integrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentfactory/integrations")>();
  const realAdapter = new actual.TelegramChannelAdapter({ botToken: "test-token" });
  return {
    ...actual,
    createChannelAdapter: () => ({
      receive: realAdapter.receive.bind(realAdapter),
      send: mockSend,
      sendMenu: mockSendMenu,
      sendTyping: mockSendTyping,
    }),
  };
});

vi.mock("@agentfactory/queue", () => ({ enqueueRunJob: vi.fn() }));

async function setupOrgWithBot() {
  const org = await insertOrg();
  const user = await insertUser();
  await insertMembership(org.id, user.id, "admin");
  const credentialRef = await createConnectionSecret(org.id, { botToken: "test-token" });
  const connection = await createConnection(org.id, {
    provider: "telegram",
    kind: "channel",
    label: "Telegram",
    auth: "api_token",
    credentialRef,
    config: { botUsername: "test_bot", webhookSecret: "wh-secret-1" },
  });
  return { org, user, connection };
}

// Telegram's real webhook request always carries this header once secret_token is registered
// (see the connect route in Task 8) — every request built in these tests includes it, matching
// what the live route actually receives.
function webhookRequest(webhookSecret: string, chatId: number, text?: string, callbackData?: string) {
  const update = callbackData
    ? { callback_query: { id: "cbq-1", message: { chat: { id: chatId } }, data: callbackData } }
    : { message: { chat: { id: chatId }, text } };
  return new Request(`http://test/api/webhooks/telegram/${webhookSecret}`, {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": webhookSecret },
    body: JSON.stringify(update),
  });
}

describe("POST /api/webhooks/telegram/[webhookSecret]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 404 for an unknown webhook secret", async () => {
    const res = await POST(webhookRequest("no-such-secret", 1, "/start"), {
      params: Promise.resolve({ webhookSecret: "no-such-secret" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the secret header doesn't match the path secret", async () => {
    await setupOrgWithBot();
    const req = new Request("http://test/api/webhooks/telegram/wh-secret-1", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "wrong-header-value" },
      body: JSON.stringify({ message: { chat: { id: 1 }, text: "/start" } }),
    });
    const res = await POST(req, { params: Promise.resolve({ webhookSecret: "wh-secret-1" }) });
    expect(res.status).toBe(404);
  });

  it("asks an unauthorized chat for an invite code", async () => {
    const { connection } = await setupOrgWithBot();
    const res = await POST(webhookRequest("wh-secret-1", 100, "hello"), {
      params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
    });
    expect(res.status).toBe(200);
    await expect(getAuthorizationStatus(connection.id, "100")).resolves.toBe("unknown");
  });

  it("authorizes a chat and shows the agent menu on a valid /start <code> deep link", async () => {
    const { org, user, connection } = await setupOrgWithBot();
    await insertAgent(org.id, { name: "Backend Bot" });
    const invite = await generateInviteCode(org.id, connection.id, user.id);

    const res = await POST(webhookRequest("wh-secret-1", 200, `/start ${invite.code}`), {
      params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
    });

    expect(res.status).toBe(200);
    await expect(getAuthorizationStatus(connection.id, "200")).resolves.toBe("authorized");
  });

  it("creates a session on an agent-menu button tap and starts a run on the next free-text message", async () => {
    const { org, user, connection } = await setupOrgWithBot();
    const agent = await insertAgent(org.id, { name: "Backend Bot" });
    const invite = await generateInviteCode(org.id, connection.id, user.id);

    await POST(webhookRequest("wh-secret-1", 300, `/start ${invite.code}`), {
      params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
    });
    await POST(webhookRequest("wh-secret-1", 300, undefined, `agent:${agent.id}`), {
      params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
    });

    const session = await findSessionByExternalThread(org.id, "telegram", "300");
    expect(session?.agentId).toBe(agent.id);

    await POST(webhookRequest("wh-secret-1", 300, "hi there"), {
      params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
    });

    const messages = await listMessages(session!.id);
    expect(messages.some((m) => m.role === "user" && m.content === "hi there")).toBe(true);
    const { enqueueRunJob } = await import("@agentfactory/queue");
    expect(enqueueRunJob).toHaveBeenCalled();
  });

  it("rejects a redemption attempt with an invalid code and locks out after 5 failures", async () => {
    const { connection } = await setupOrgWithBot();
    for (let i = 0; i < 5; i++) {
      await POST(webhookRequest("wh-secret-1", 400, "WRONGCODE"), {
        params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
      });
    }
    await expect(getAuthorizationStatus(connection.id, "400")).resolves.toBe("unknown");
    // A 6th attempt should short-circuit on cooldown before ever calling redeemInviteCode again —
    // verified indirectly: the route still returns 200 (never errors) and status stays "unknown".
    const res = await POST(webhookRequest("wh-secret-1", 400, "WRONGCODE"), {
      params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
    });
    expect(res.status).toBe(200);
  });

  it("blocks a message from a revoked user, sends the revocation reply, and creates no run", async () => {
    const { org, user, connection } = await setupOrgWithBot();
    const agent = await insertAgent(org.id, { name: "Backend Bot" });
    const invite = await generateInviteCode(org.id, connection.id, user.id);

    await POST(webhookRequest("wh-secret-1", 500, `/start ${invite.code}`), {
      params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
    });
    await POST(webhookRequest("wh-secret-1", 500, undefined, `agent:${agent.id}`), {
      params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
    });
    const session = await findSessionByExternalThread(org.id, "telegram", "500");

    // authorizeExternalUser is an upsert (Task 5) — calling it again here just fetches the row
    // the route already created above, so its id can be passed to revokeAuthorizedUser.
    const authorized = await authorizeExternalUser(connection.id, "500");
    await revokeAuthorizedUser(connection.id, authorized.id);
    mockSend.mockClear();

    const res = await POST(webhookRequest("wh-secret-1", 500, "are you there?"), {
      params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
    });

    expect(res.status).toBe(200);
    expect(mockSend).toHaveBeenCalledWith("500", expect.stringContaining("revoked"));
    // The button tap only creates the session, never a run — so a revoked user's message
    // producing zero runs here is what proves the revocation check actually short-circuited.
    await expect(getRunsForSession(session!.id)).resolves.toHaveLength(0);
  });

  it("shows a 'no agents set up' fallback when the org has zero agents, and creates no session", async () => {
    const { org, user, connection } = await setupOrgWithBot();
    const invite = await generateInviteCode(org.id, connection.id, user.id);
    mockSend.mockClear();

    const res = await POST(webhookRequest("wh-secret-1", 600, `/start ${invite.code}`), {
      params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
    });

    expect(res.status).toBe(200);
    expect(mockSend).toHaveBeenCalledWith("600", expect.stringContaining("No agents"));
    await expect(findSessionByExternalThread(org.id, "telegram", "600")).resolves.toBeUndefined();
  });

  it("still returns 200 when a repository call inside handleInbound throws", async () => {
    const { org, user, connection } = await setupOrgWithBot();
    const agent = await insertAgent(org.id, { name: "Backend Bot" });
    const invite = await generateInviteCode(org.id, connection.id, user.id);

    await POST(webhookRequest("wh-secret-1", 800, `/start ${invite.code}`), {
      params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
    });
    await POST(webhookRequest("wh-secret-1", 800, undefined, `agent:${agent.id}`), {
      params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
    });

    const createMessageSpy = vi.spyOn(db, "createMessage").mockRejectedValueOnce(new Error("connection reset"));
    const res = await POST(webhookRequest("wh-secret-1", 800, "hi there"), {
      params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
    });

    expect(res.status).toBe(200);
    createMessageSpy.mockRestore();
  });

  it("falls back to the agent menu instead of crashing on a malformed callback_data agent id", async () => {
    const { org, user, connection } = await setupOrgWithBot();
    await insertAgent(org.id, { name: "Backend Bot" });
    const invite = await generateInviteCode(org.id, connection.id, user.id);

    await POST(webhookRequest("wh-secret-1", 900, `/start ${invite.code}`), {
      params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
    });
    mockSendMenu.mockClear();

    const res = await POST(webhookRequest("wh-secret-1", 900, undefined, "agent:xyz"), {
      params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
    });

    expect(res.status).toBe(200);
    expect(mockSendMenu).toHaveBeenCalled();
    await expect(findSessionByExternalThread(org.id, "telegram", "900")).resolves.toBeUndefined();
  });

  it("rejects an invite code redeemed against a different connection's org", async () => {
    const { connection: connectionA } = await setupOrgWithBot();
    const orgB = await insertOrg();
    const userB = await insertUser();
    await insertMembership(orgB.id, userB.id, "admin");
    const credentialRefB = await createConnectionSecret(orgB.id, { botToken: "test-token-b" });
    const connectionB = await createConnection(orgB.id, {
      provider: "telegram",
      kind: "channel",
      label: "Telegram B",
      auth: "api_token",
      credentialRef: credentialRefB,
      config: { botUsername: "test_bot_b", webhookSecret: "wh-secret-b" },
    });
    const inviteForB = await generateInviteCode(orgB.id, connectionB.id, userB.id);

    // The code was minted for connection B's org, but arrives on connection A's webhook.
    const res = await POST(webhookRequest("wh-secret-1", 1000, `/start ${inviteForB.code}`), {
      params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
    });

    expect(res.status).toBe(200);
    expect(mockSend).toHaveBeenCalledWith("1000", expect.stringContaining("isn't valid"));
    await expect(getAuthorizationStatus(connectionA.id, "1000")).resolves.toBe("unknown");
    // The code is burned by the atomic UPDATE regardless — but nobody ends up authorized
    // anywhere, on either connection.
    await expect(getAuthorizationStatus(connectionB.id, "1000")).resolves.toBe("unknown");
  });
});
