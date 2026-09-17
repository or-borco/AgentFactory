import { describe, expect, it, vi, afterAll, afterEach } from "vitest";
import { Queue } from "bullmq";
import "@agentfactory/db/src/__tests__/setup.js";
import { insertOrg, insertAgent, insertUser, insertMembership } from "@agentfactory/db/src/__tests__/fixtures.js";
import { createConnection, createConnectionSecret, generateInviteCode } from "@agentfactory/db";
import { RUN_QUEUE_NAME, queueConnection } from "@agentfactory/queue";
import { POST } from "../[webhookSecret]/route";

// Only the Telegram side effects are stubbed here — @agentfactory/queue is deliberately left real
// (unlike route.test.ts) so enqueueRunJob hits actual Redis.
vi.mock("@agentfactory/integrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentfactory/integrations")>();
  const realAdapter = new actual.TelegramChannelAdapter({ botToken: "test-token" });
  return {
    ...actual,
    createChannelAdapter: () => ({
      receive: realAdapter.receive.bind(realAdapter),
      send: vi.fn(),
      sendMenu: vi.fn(),
      sendTyping: vi.fn(),
    }),
  };
});

// The path segment and the header value are two independently-generated secrets (see the
// connect route) — kept distinct here so the route's header check is exercised for real.
const SECRET_TOKEN = "tg-token-queue";

const inspectQueue = new Queue(RUN_QUEUE_NAME, { connection: queueConnection });

afterEach(async () => {
  await inspectQueue.obliterate({ force: true });
});

afterAll(async () => {
  await inspectQueue.close();
  await queueConnection.quit();
});

function webhookRequest(webhookSecret: string, chatId: number, text?: string, callbackData?: string) {
  const update = callbackData
    ? { callback_query: { id: "cbq-1", message: { chat: { id: chatId } }, data: callbackData } }
    : { message: { chat: { id: chatId }, text } };
  return new Request(`http://test/api/webhooks/telegram/${webhookSecret}`, {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET_TOKEN },
    body: JSON.stringify(update),
  });
}

describe("POST /api/webhooks/telegram/[webhookSecret] — real queue", () => {
  it("enqueues a real BullMQ job carrying the run id when a bound session gets a message", async () => {
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
      config: { botUsername: "test_bot", webhookSecret: "wh-secret-queue", telegramSecretToken: SECRET_TOKEN },
    });
    const agent = await insertAgent(org.id, { name: "Backend Bot" });
    const invite = await generateInviteCode(org.id, connection.id, user.id);

    await POST(webhookRequest("wh-secret-queue", 700, `/start ${invite.code}`), {
      params: Promise.resolve({ webhookSecret: "wh-secret-queue" }),
    });
    await POST(webhookRequest("wh-secret-queue", 700, undefined, `agent:${agent.id}`), {
      params: Promise.resolve({ webhookSecret: "wh-secret-queue" }),
    });
    await POST(webhookRequest("wh-secret-queue", 700, "hi there"), {
      params: Promise.resolve({ webhookSecret: "wh-secret-queue" }),
    });

    const jobs = await inspectQueue.getJobs(["waiting", "delayed"]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe("process-run");
    expect(typeof jobs[0].data.runId).toBe("number");
  });
});
