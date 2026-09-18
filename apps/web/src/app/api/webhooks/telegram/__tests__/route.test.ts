import { describe, expect, it, vi, beforeEach } from "vitest";
import "@agentfactory/db/src/__tests__/setup.js";
import { insertOrg, insertAgent, insertUser, insertMembership, insertTask } from "@agentfactory/db/src/__tests__/fixtures.js";
import {
  createConnection,
  createConnectionSecret,
  generateInviteCode,
  getAuthorizationStatus,
  getAuthorizedUser,
  authorizeExternalUser,
  revokeAuthorizedUser,
  getTask,
  listMessages,
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
// They resolve rather than returning undefined because the real ChannelAdapter methods are
// declared Promise-returning and the route awaits them — a bare vi.fn() would make `await` on a
// non-thenable pass by accident where the real thing would not.
const { mockSend, mockSendMenu, mockSendTyping } = vi.hoisted(() => ({
  mockSend: vi.fn().mockResolvedValue(undefined),
  mockSendMenu: vi.fn().mockResolvedValue(undefined),
  mockSendTyping: vi.fn().mockResolvedValue(undefined),
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

// The URL path segment and the header value are two independently-generated secrets (see the
// connect route) — these fixtures keep them distinct so a test that confuses them fails.
const SECRET_TOKEN = "tg-token-1";
// Shaped like a real code (8 chars from the Crockford-ish alphabet generateInviteCode uses) but
// never minted, so it reaches redeemInviteCode and fails there rather than being filtered out as
// "not a code attempt".
const WRONG_CODE = "ABCDEFGH";

async function setupOrgWithBot() {
  const org = await insertOrg();
  const user = await insertUser();
  // "owner", not "admin": inviterUserIdFor's getOrgOwnerUserId fallback (used whenever a test
  // authorizes a chat via authorizeExternalUser() directly, bypassing invite-code redemption and
  // so leaving no redeemer row) only finds a membership with role "owner".
  await insertMembership(org.id, user.id, "owner");
  const credentialRef = await createConnectionSecret(org.id, { botToken: "test-token" });
  const connection = await createConnection(org.id, {
    provider: "telegram",
    kind: "channel",
    label: "Telegram",
    auth: "api_token",
    credentialRef,
    config: { botUsername: "test_bot", webhookSecret: "wh-secret-1", telegramSecretToken: SECRET_TOKEN },
  });
  return { org, user, connection };
}

// Telegram's real webhook request always carries this header once secret_token is registered
// (see the connect route in Task 8) — every request built in these tests includes it, matching
// what the live route actually receives.
function webhookRequest(
  webhookSecret: string,
  chatId: number,
  text?: string,
  callbackData?: string,
  secretToken: string = SECRET_TOKEN,
) {
  const update = callbackData
    ? { callback_query: { id: "cbq-1", message: { chat: { id: chatId } }, data: callbackData } }
    : { message: { chat: { id: chatId }, text } };
  return new Request(`http://test/api/webhooks/telegram/${webhookSecret}`, {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": secretToken },
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

  it("returns 404 when the secret header doesn't match the stored secret token", async () => {
    await setupOrgWithBot();
    const req = new Request("http://test/api/webhooks/telegram/wh-secret-1", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "wrong-header-value" },
      body: JSON.stringify({ message: { chat: { id: 1 }, text: "/start" } }),
    });
    const res = await POST(req, { params: Promise.resolve({ webhookSecret: "wh-secret-1" }) });
    expect(res.status).toBe(404);
  });

  // The whole point of the two layers: whoever scrapes the path secret out of an access log still
  // can't forge an update, because the header is a separately-generated value.
  it("returns 404 when the header carries the path secret instead of the stored secret token", async () => {
    await setupOrgWithBot();
    const req = new Request("http://test/api/webhooks/telegram/wh-secret-1", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "wh-secret-1" },
      body: JSON.stringify({ message: { chat: { id: 1 }, text: "/start" } }),
    });
    const res = await POST(req, { params: Promise.resolve({ webhookSecret: "wh-secret-1" }) });
    expect(res.status).toBe(404);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("accepts a request carrying the stored secret token in the header", async () => {
    await setupOrgWithBot();
    const res = await POST(webhookRequest("wh-secret-1", 1, "/start", undefined, SECRET_TOKEN), {
      params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
    });
    expect(res.status).toBe(200);
    expect(mockSend).toHaveBeenCalledWith("1", expect.stringContaining("invite code"));
  });

  it("returns 404 when the connection has no stored secret token at all", async () => {
    const org = await insertOrg();
    const credentialRef = await createConnectionSecret(org.id, { botToken: "test-token" });
    await createConnection(org.id, {
      provider: "telegram",
      kind: "channel",
      label: "Legacy Telegram",
      auth: "api_token",
      credentialRef,
      config: { botUsername: "legacy_bot", webhookSecret: "wh-secret-legacy" },
    });
    const res = await POST(webhookRequest("wh-secret-legacy", 2, "/start", undefined, "wh-secret-legacy"), {
      params: Promise.resolve({ webhookSecret: "wh-secret-legacy" }),
    });
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

  it("rejects a redemption attempt with an invalid code and locks out after 5 failures", async () => {
    const { connection } = await setupOrgWithBot();
    for (let i = 0; i < 5; i++) {
      await POST(webhookRequest("wh-secret-1", 400, WRONG_CODE), {
        params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
      });
    }
    await expect(getAuthorizationStatus(connection.id, "400")).resolves.toBe("unknown");
    // A 6th attempt should short-circuit on cooldown before ever calling redeemInviteCode again —
    // verified indirectly: the route still returns 200 (never errors) and status stays "unknown".
    const res = await POST(webhookRequest("wh-secret-1", 400, WRONG_CODE), {
      params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
    });
    expect(res.status).toBe(200);
    expect(mockSend).toHaveBeenLastCalledWith("400", expect.stringContaining("Too many"));
  });

  it("treats free text that isn't code-shaped as a question, not a redemption attempt", async () => {
    const { connection } = await setupOrgWithBot();
    const redeemSpy = vi.spyOn(db, "redeemInviteCode");
    const recordSpy = vi.spyOn(db, "recordFailedRedemption");

    for (const text of ["hi", "hello there", "what is this?"]) {
      const res = await POST(webhookRequest("wh-secret-1", 410, text), {
        params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
      });
      expect(res.status).toBe(200);
      expect(mockSend).toHaveBeenLastCalledWith("410", expect.stringContaining("Send your invite code"));
    }

    expect(redeemSpy).not.toHaveBeenCalled();
    expect(recordSpy).not.toHaveBeenCalled();
    await expect(getAuthorizationStatus(connection.id, "410")).resolves.toBe("unknown");
    redeemSpy.mockRestore();
    recordSpy.mockRestore();
  });

  it("requires five genuine wrong codes to lock out — chatter in between doesn't count", async () => {
    await setupOrgWithBot();
    for (let i = 0; i < 4; i++) {
      await POST(webhookRequest("wh-secret-1", 420, WRONG_CODE), {
        params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
      });
    }
    // Four real attempts plus small talk: still one short of the five-attempt cooldown.
    await POST(webhookRequest("wh-secret-1", 420, "hi"), {
      params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
    });
    await POST(webhookRequest("wh-secret-1", 420, WRONG_CODE), {
      params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
    });
    expect(mockSend).toHaveBeenLastCalledWith("420", expect.stringContaining("isn't valid"));

    // The fifth wrong code is the one that trips it, so the next code attempt hits the cooldown.
    await POST(webhookRequest("wh-secret-1", 420, WRONG_CODE), {
      params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
    });
    expect(mockSend).toHaveBeenLastCalledWith("420", expect.stringContaining("Too many"));
  });

  it("redeems a code typed in lowercase", async () => {
    const { org, user, connection } = await setupOrgWithBot();
    await insertAgent(org.id, { name: "Backend Bot" });
    const invite = await generateInviteCode(org.id, connection.id, user.id);
    const recordSpy = vi.spyOn(db, "recordFailedRedemption");

    const res = await POST(webhookRequest("wh-secret-1", 540, invite.code.toLowerCase()), {
      params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
    });

    expect(res.status).toBe(200);
    await expect(getAuthorizationStatus(connection.id, "540")).resolves.toBe("authorized");
    expect(recordSpy).not.toHaveBeenCalled();
    recordSpy.mockRestore();
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

  it("blocks a message from a revoked user and sends the revocation reply", async () => {
    const { connection } = await setupOrgWithBot();
    const authorizedUser = await authorizeExternalUser(connection.id, "700");
    await revokeAuthorizedUser(connection.id, authorizedUser.id);

    const res = await POST(webhookRequest("wh-secret-1", 700, "hello again"), {
      params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
    });

    expect(res.status).toBe(200);
    expect(mockSend).toHaveBeenCalledWith("700", "Your access was revoked — ask your admin for a new invite.");
    await expect(getAuthorizationStatus(connection.id, "700")).resolves.toBe("revoked");
  });

  it("still returns 200 when a repository call inside handleInbound throws", async () => {
    const { org, connection } = await setupOrgWithBot();
    const agent = await insertAgent(org.id, { name: "Backend Bot" });
    await authorizeExternalUser(connection.id, "800");
    await POST(webhookRequest("wh-secret-1", 800, undefined, "newtask"), {
      params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
    });
    await POST(webhookRequest("wh-secret-1", 800, "Fix the login bug"), {
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

  describe("fresh authorization", () => {
    it("shows the main menu, not the old agent menu", async () => {
      const { org, user, connection } = await setupOrgWithBot();
      const invite = await generateInviteCode(org.id, connection.id, user.id);

      await POST(webhookRequest("wh-secret-1", 1, `/start ${invite.code}`), {
        params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
      });

      expect(mockSendMenu).toHaveBeenCalledWith(
        "1",
        "What would you like to do?",
        expect.arrayContaining([{ label: "Start a new task", value: "newtask" }]),
      );
    });
  });

  describe("starting a new task", () => {
    it("newtask tap creates a draft task, sets activeTaskId, sends the description prompt", async () => {
      const { connection } = await setupOrgWithBot();
      await authorizeExternalUser(connection.id, "1");

      await POST(webhookRequest("wh-secret-1", 1, undefined, "newtask"), {
        params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
      });

      expect(mockSend).toHaveBeenCalledWith("1", "Tell me what you need done.");
      const authorizedUser = await getAuthorizedUser(connection.id, "1");
      const task = await getTask(authorizedUser!.activeTaskId!);
      expect(task?.title).toBe("New task");
      expect(task?.description).toBe("");
    });

    it("description text updates the task and shows the agent picker", async () => {
      const { org, connection } = await setupOrgWithBot();
      await authorizeExternalUser(connection.id, "1");
      await POST(webhookRequest("wh-secret-1", 1, undefined, "newtask"), { params: Promise.resolve({ webhookSecret: "wh-secret-1" }) });
      const agent = await insertAgent(org.id);

      await POST(webhookRequest("wh-secret-1", 1, "Fix the login bug"), { params: Promise.resolve({ webhookSecret: "wh-secret-1" }) });

      expect(mockSendMenu).toHaveBeenCalledWith("1", "Who should work on this?", [{ label: agent.name, value: `agent:${agent.id}` }]);
      const authorizedUser = await getAuthorizedUser(connection.id, "1");
      const task = await getTask(authorizedUser!.activeTaskId!);
      expect(task?.title).toBe("Fix the login bug");
      expect(task?.description).toBe("Fix the login bug");
    });

    it("agent tap creates the session, updates the task, and enqueues a run", async () => {
      const { org, connection } = await setupOrgWithBot();
      const agent = await insertAgent(org.id);
      await authorizeExternalUser(connection.id, "1");
      await POST(webhookRequest("wh-secret-1", 1, undefined, "newtask"), { params: Promise.resolve({ webhookSecret: "wh-secret-1" }) });
      await POST(webhookRequest("wh-secret-1", 1, "Fix the login bug"), { params: Promise.resolve({ webhookSecret: "wh-secret-1" }) });

      await POST(webhookRequest("wh-secret-1", 1, undefined, `agent:${agent.id}`), { params: Promise.resolve({ webhookSecret: "wh-secret-1" }) });

      const authorizedUser = await getAuthorizedUser(connection.id, "1");
      const task = await getTask(authorizedUser!.activeTaskId!);
      expect(task?.assigneeAgentId).toBe(agent.id);
      expect(task?.sessionId).toBeDefined();
      expect(task?.status).toBe("in_progress");
      const { enqueueRunJob } = await import("@agentfactory/queue");
      expect(enqueueRunJob).toHaveBeenCalled();
    });

    it("falls back to the agent menu on a malformed or cross-org agent callback", async () => {
      const { org, connection } = await setupOrgWithBot();
      const agent = await insertAgent(org.id, { name: "Backend Bot" });
      const otherOrg = await insertOrg();
      const otherAgent = await insertAgent(otherOrg.id, { name: "Other Org Bot" });
      await authorizeExternalUser(connection.id, "1");
      await POST(webhookRequest("wh-secret-1", 1, undefined, "newtask"), { params: Promise.resolve({ webhookSecret: "wh-secret-1" }) });
      await POST(webhookRequest("wh-secret-1", 1, "Fix the login bug"), { params: Promise.resolve({ webhookSecret: "wh-secret-1" }) });
      mockSendMenu.mockClear();

      await POST(webhookRequest("wh-secret-1", 1, undefined, "agent:not-a-number"), {
        params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
      });
      expect(mockSendMenu).toHaveBeenCalledWith("1", "Who should work on this?", [{ label: agent.name, value: `agent:${agent.id}` }]);
      mockSendMenu.mockClear();

      await POST(webhookRequest("wh-secret-1", 1, undefined, `agent:${otherAgent.id}`), {
        params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
      });
      expect(mockSendMenu).toHaveBeenCalledWith("1", "Who should work on this?", [{ label: agent.name, value: `agent:${agent.id}` }]);

      const authorizedUser = await getAuthorizedUser(connection.id, "1");
      const task = await getTask(authorizedUser!.activeTaskId!);
      expect(task?.assigneeAgentId).toBeFalsy();
    });
  });

  describe("switching tasks", () => {
    it("a menu tap while a different task is running is honored immediately and leaves the previous task's session untouched", async () => {
      const { org, connection } = await setupOrgWithBot();
      const agent = await insertAgent(org.id);
      const user = await insertUser();
      const runningTask = await insertTask(org.id, user.id, { assigneeAgentId: agent.id });
      await authorizeExternalUser(connection.id, "1");
      const { setActiveTask } = db;
      await setActiveTask(connection.id, "1", runningTask.id);
      // Give the "running" task a real session via startTaskSession directly, bypassing the bot
      // flow, to set up the precondition without re-deriving it through several webhook calls.
      const { startTaskSession } = db;
      const started = await startTaskSession(runningTask.id, org.id, agent.id, runningTask.title, "brief", { origin: "telegram", externalThreadRef: "1" });
      if (!started.started) throw new Error("setup failed");

      await POST(webhookRequest("wh-secret-1", 1, undefined, "newtask"), { params: Promise.resolve({ webhookSecret: "wh-secret-1" }) });

      expect(mockSend).toHaveBeenCalledWith("1", "Tell me what you need done.");
      const untouchedTask = await getTask(runningTask.id);
      expect(untouchedTask?.sessionId).toBe(started.session.id); // unchanged
    });

    it("a task: tap on a task that is already running replies with a welcome-back message and creates nothing new", async () => {
      const { org, connection } = await setupOrgWithBot();
      const agent = await insertAgent(org.id);
      const user = await insertUser();
      const runningTask = await insertTask(org.id, user.id, { assigneeAgentId: agent.id });
      await authorizeExternalUser(connection.id, "1");
      const { startTaskSession } = db;
      const started = await startTaskSession(runningTask.id, org.id, agent.id, runningTask.title, "brief", { origin: "telegram", externalThreadRef: "1" });
      if (!started.started) throw new Error("setup failed");

      await POST(webhookRequest("wh-secret-1", 1, undefined, `task:${runningTask.id}`), { params: Promise.resolve({ webhookSecret: "wh-secret-1" }) });

      expect(mockSend).toHaveBeenCalledWith("1", expect.stringContaining("Welcome back"));
      const messagesAfter = await listMessages(started.session.id);
      expect(messagesAfter).toHaveLength(1); // only the original brief — nothing new added
    });

    it("plain text without tapping anything first still forwards to whichever task is currently active", async () => {
      const { org, connection } = await setupOrgWithBot();
      const agent = await insertAgent(org.id);
      const user = await insertUser();
      const task = await insertTask(org.id, user.id, { assigneeAgentId: agent.id });
      await authorizeExternalUser(connection.id, "1");
      const { setActiveTask, startTaskSession } = db;
      await setActiveTask(connection.id, "1", task.id);
      const started = await startTaskSession(task.id, org.id, agent.id, task.title, "brief", { origin: "telegram", externalThreadRef: "1" });
      if (!started.started) throw new Error("setup failed");

      await POST(webhookRequest("wh-secret-1", 1, "another instruction"), { params: Promise.resolve({ webhookSecret: "wh-secret-1" }) });

      const messagesAfter = await listMessages(started.session.id);
      expect(messagesAfter.map((m) => m.content)).toContain("another instruction");
    });

    it("a task: tap on a tampered/cross-org id shows the main menu and leaks nothing", async () => {
      const { connection } = await setupOrgWithBot();
      const otherOrg = await insertOrg();
      const otherUser = await insertUser();
      const otherTask = await insertTask(otherOrg.id, otherUser.id, { description: "SECRET cross-org description" });
      await authorizeExternalUser(connection.id, "1");

      await POST(webhookRequest("wh-secret-1", 1, undefined, `task:${otherTask.id}`), { params: Promise.resolve({ webhookSecret: "wh-secret-1" }) });

      expect(mockSendMenu).toHaveBeenCalledWith("1", "What would you like to do?", expect.anything());
      for (const call of mockSend.mock.calls) {
        expect(call[1]).not.toContain("SECRET");
      }
    });

    it("a task: tap on a task with an agent but no session (e.g. created via the web UI) auto-starts", async () => {
      const { org, connection } = await setupOrgWithBot();
      const agent = await insertAgent(org.id);
      const user = await insertUser();
      const webTask = await insertTask(org.id, user.id, { assigneeAgentId: agent.id, description: "Do the thing" });
      await authorizeExternalUser(connection.id, "1");

      await POST(webhookRequest("wh-secret-1", 1, undefined, `task:${webTask.id}`), { params: Promise.resolve({ webhookSecret: "wh-secret-1" }) });

      const updated = await getTask(webTask.id);
      expect(updated?.sessionId).toBeDefined();
      expect(mockSend).toHaveBeenCalledWith("1", expect.stringContaining("Starting"));
    });

    it("a web-created task with an empty description but a real title keeps its title when resumed", async () => {
      const { org, connection } = await setupOrgWithBot();
      const user = await insertUser();
      const webTask = await insertTask(org.id, user.id, { title: "Real title from the web", description: "" });
      await authorizeExternalUser(connection.id, "1");

      await POST(webhookRequest("wh-secret-1", 1, undefined, `task:${webTask.id}`), { params: Promise.resolve({ webhookSecret: "wh-secret-1" }) });

      // Not treated as the "New task" draft sentinel, since the title isn't the literal placeholder.
      const unchanged = await getTask(webTask.id);
      expect(unchanged?.title).toBe("Real title from the web");
    });
  });

  describe("cross-chat / cross-origin session ownership", () => {
    it("resuming a task whose session was started from the web says it's running elsewhere and enqueues nothing", async () => {
      const { org, connection } = await setupOrgWithBot();
      const agent = await insertAgent(org.id);
      const user = await insertUser();
      const webTask = await insertTask(org.id, user.id, { assigneeAgentId: agent.id });
      await authorizeExternalUser(connection.id, "1");
      const { startTaskSession } = db;
      const started = await startTaskSession(webTask.id, org.id, agent.id, webTask.title, "brief", { origin: "web" });
      if (!started.started) throw new Error("setup failed");

      await POST(webhookRequest("wh-secret-1", 1, undefined, `task:${webTask.id}`), {
        params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
      });

      expect(mockSend).toHaveBeenCalledWith("1", expect.stringContaining("already running elsewhere"));
      const { enqueueRunJob } = await import("@agentfactory/queue");
      expect(enqueueRunJob).not.toHaveBeenCalled();
      const messagesAfter = await listMessages(started.session.id);
      expect(messagesAfter).toHaveLength(1); // only the original web-side brief — nothing forwarded in
    });

    it("a second chat that points its activeTaskId at another chat's running task can't relay messages into it", async () => {
      const { org, connection } = await setupOrgWithBot();
      const agent = await insertAgent(org.id);
      const user = await insertUser();
      const task = await insertTask(org.id, user.id, { assigneeAgentId: agent.id });
      await authorizeExternalUser(connection.id, "1"); // the chat that actually owns the session
      await authorizeExternalUser(connection.id, "2"); // a different chat pointed at the same task
      const { startTaskSession, setActiveTask } = db;
      const started = await startTaskSession(task.id, org.id, agent.id, task.title, "brief", {
        origin: "telegram",
        externalThreadRef: "1",
      });
      if (!started.started) throw new Error("setup failed");
      await setActiveTask(connection.id, "2", task.id);

      await POST(webhookRequest("wh-secret-1", 2, "let me help with this"), {
        params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
      });

      expect(mockSend).toHaveBeenCalledWith("2", expect.stringContaining("already running elsewhere"));
      const { enqueueRunJob } = await import("@agentfactory/queue");
      expect(enqueueRunJob).not.toHaveBeenCalled();
      const messagesAfter = await listMessages(started.session.id);
      expect(messagesAfter.map((m) => m.content)).not.toContain("let me help with this");
    });
  });

  describe("re-authorization", () => {
    it("resumes at the welcome-back step without ever writing the redeemed code as a session message", async () => {
      const { org, connection, user } = await setupOrgWithBot();
      const agent = await insertAgent(org.id);
      const task = await insertTask(org.id, user.id, { assigneeAgentId: agent.id });
      const authorizedUser = await authorizeExternalUser(connection.id, "1");
      const { setActiveTask, startTaskSession, revokeAuthorizedUser: revoke } = db;
      await setActiveTask(connection.id, "1", task.id);
      const started = await startTaskSession(task.id, org.id, agent.id, task.title, "brief", { origin: "telegram", externalThreadRef: "1" });
      if (!started.started) throw new Error("setup failed");
      await revoke(connection.id, authorizedUser.id);

      const invite = await generateInviteCode(org.id, connection.id, user.id);
      await POST(webhookRequest("wh-secret-1", 1, invite.code), { params: Promise.resolve({ webhookSecret: "wh-secret-1" }) });

      expect(mockSend).toHaveBeenCalledWith("1", expect.stringContaining("Welcome back"));
      const messagesAfter = await listMessages(started.session.id);
      expect(messagesAfter.map((m) => m.content)).not.toContain(invite.code);
    });
  });

  describe("running-task message handling", () => {
    it("resets a failed task's status to in_progress when a forwarded message arrives", async () => {
      const { org, connection } = await setupOrgWithBot();
      const agent = await insertAgent(org.id);
      const user = await insertUser();
      const task = await insertTask(org.id, user.id, { assigneeAgentId: agent.id });
      await authorizeExternalUser(connection.id, "1");
      const { setActiveTask, startTaskSession, updateTask: update } = db;
      await setActiveTask(connection.id, "1", task.id);
      const started = await startTaskSession(task.id, org.id, agent.id, task.title, "brief", { origin: "telegram", externalThreadRef: "1" });
      if (!started.started) throw new Error("setup failed");
      await update(task.id, { status: "failed" });

      await POST(webhookRequest("wh-secret-1", 1, "try again"), { params: Promise.resolve({ webhookSecret: "wh-secret-1" }) });

      const updated = await getTask(task.id);
      expect(updated?.status).toBe("in_progress");
    });

    it("a done task just receives the message/run without a status change", async () => {
      const { org, connection } = await setupOrgWithBot();
      const agent = await insertAgent(org.id);
      const user = await insertUser();
      const task = await insertTask(org.id, user.id, { assigneeAgentId: agent.id });
      await authorizeExternalUser(connection.id, "1");
      const { setActiveTask, startTaskSession, updateTask: update } = db;
      await setActiveTask(connection.id, "1", task.id);
      const started = await startTaskSession(task.id, org.id, agent.id, task.title, "brief", { origin: "telegram", externalThreadRef: "1" });
      if (!started.started) throw new Error("setup failed");
      await update(task.id, { status: "done" });

      await POST(webhookRequest("wh-secret-1", 1, "one more thing"), { params: Promise.resolve({ webhookSecret: "wh-secret-1" }) });

      const updated = await getTask(task.id);
      expect(updated?.status).toBe("done");
      const messagesAfter = await listMessages(started.session.id);
      expect(messagesAfter.map((m) => m.content)).toContain("one more thing");
    });

    it("still enqueues the run when sendTyping fails", async () => {
      const { org, connection } = await setupOrgWithBot();
      const agent = await insertAgent(org.id);
      const user = await insertUser();
      const task = await insertTask(org.id, user.id, { assigneeAgentId: agent.id });
      await authorizeExternalUser(connection.id, "1");
      const { setActiveTask, startTaskSession } = db;
      await setActiveTask(connection.id, "1", task.id);
      const started = await startTaskSession(task.id, org.id, agent.id, task.title, "brief", { origin: "telegram", externalThreadRef: "1" });
      if (!started.started) throw new Error("setup failed");
      mockSendTyping.mockRejectedValueOnce(new Error("typing indicator failed"));

      const res = await POST(webhookRequest("wh-secret-1", 1, "keep going"), {
        params: Promise.resolve({ webhookSecret: "wh-secret-1" }),
      });

      expect(res.status).toBe(200);
      const { enqueueRunJob } = await import("@agentfactory/queue");
      expect(enqueueRunJob).toHaveBeenCalled();
      const messagesAfter = await listMessages(started.session.id);
      expect(messagesAfter.map((m) => m.content)).toContain("keep going");
    });
  });

  describe("zero agents configured", () => {
    it("sends the no-agents message and keeps activeTaskId pointed at the draft", async () => {
      const { connection } = await setupOrgWithBot();
      await authorizeExternalUser(connection.id, "1");
      await POST(webhookRequest("wh-secret-1", 1, undefined, "newtask"), { params: Promise.resolve({ webhookSecret: "wh-secret-1" }) });

      await POST(webhookRequest("wh-secret-1", 1, "Fix the thing"), { params: Promise.resolve({ webhookSecret: "wh-secret-1" }) });

      expect(mockSend).toHaveBeenCalledWith("1", "No agents are set up for this org yet — ask your admin.");
      const authorizedUser = await getAuthorizedUser(connection.id, "1");
      expect(authorizedUser?.activeTaskId).toBeDefined();
    });
  });

  describe("task attribution", () => {
    it("createdBy matches the invite code's createdBy", async () => {
      const { org, connection, user } = await setupOrgWithBot(); // user is the admin who owns the connection's invite code below
      const invite = await generateInviteCode(org.id, connection.id, user.id);
      await POST(webhookRequest("wh-secret-1", 1, invite.code), { params: Promise.resolve({ webhookSecret: "wh-secret-1" }) });

      await POST(webhookRequest("wh-secret-1", 1, undefined, "newtask"), { params: Promise.resolve({ webhookSecret: "wh-secret-1" }) });

      const authorizedUser = await getAuthorizedUser(connection.id, "1");
      const task = await getTask(authorizedUser!.activeTaskId!);
      expect(task?.createdBy).toBe(user.id);
    });
  });
});
