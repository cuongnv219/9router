// Per-key daily budget wired into the /v1 handlers (real ledger in a temp
// DATA_DIR, mocked provider): a denied key never reaches the provider, combo
// fallback cannot route around the limit, failed attempts release their
// reservation, a cancelled stream still settles, and unmetered endpoints are
// closed to budget-limited keys.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-budget-h-"));
const originalDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = tempDir;

const fx = vi.hoisted(() => ({
  combos: [{ id: "c1", name: "Main", models: ["openai/gpt-4o", "openai/gpt-4o-mini"] }],
}));
const mocks = vi.hoisted(() => ({ handleChatCore: vi.fn(), getProviderCredentials: vi.fn() }));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false, comboStrategy: "fallback" }),
  getModelAliases: async () => ({}),
  getComboByName: async (name) => fx.combos.find((c) => c.name === name) || null,
  getProviderNodes: async () => [],
  getCombos: async () => fx.combos,
  getProviderConnections: async () => [],
  getProviderConnectionById: async () => null,
  getCustomModels: async () => [],
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => fx.combos }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(),
  extractApiKey: (request) => request.headers.get("Authorization")?.slice(7) || null,
  isValidApiKey: async () => true,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));

let db;
let budgetRepo;
let handleChat;
let geminiRoute;
const keys = {};

const enc = new TextEncoder();
const sse = (text) => new Response(new ReadableStream({
  start(c) { c.enqueue(enc.encode(`data: {"choices":[{"delta":{"content":"${text}"}}]}\n\n`)); c.close(); },
}), { status: 200, headers: { "Content-Type": "text/event-stream" } });
const post = (p, body, key) => new Request(`http://localhost${p}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
  body: JSON.stringify(body),
});
const chat = (model, key, extra = {}) => handleChat(post("/v1/chat/completions", { model, stream: true, max_tokens: 100, messages: [{ role: "user", content: "hi" }], ...extra }, key));
const today = async (k) => budgetRepo.getBudgetDay(k.id);
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeAll(async () => {
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  budgetRepo = await import("@/lib/db/repos/budgetRepo.js");
  ({ handleChat } = await import("../../src/sse/handlers/chat.js"));
  geminiRoute = await import("../../src/app/api/v1beta/models/[...path]/route.js");
  keys.rich = await db.createApiKey("rich", "m1", 100);
  keys.broke = await db.createApiKey("broke", "m1", 0);
  keys.open = await db.createApiKey("open", "m1", null);
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  mocks.getProviderCredentials.mockResolvedValue({ connectionId: "conn", connectionName: "mock" });
  mocks.handleChatCore.mockImplementation(async ({ modelInfo }) => ({ success: true, response: sse(`from-${modelInfo.model}`) }));
});

describe("chat handler budget guard", () => {
  it("exhausted key: 429 with Retry-After, provider never called", async () => {
    const r = await chat("openai/gpt-4o", keys.broke.key);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await r.json()).error.code).toBe("daily_budget_exceeded");
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });

  it("combo cannot route around an exhausted key", async () => {
    expect((await chat("Main", keys.broke.key)).status).toBe(429);
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });

  it("key without a budget is untouched (no reservation, no ledger rows)", async () => {
    expect((await chat("openai/gpt-4o", keys.open.key)).status).toBe(200);
    expect(mocks.handleChatCore.mock.calls[0][0].budgetReservationId).toBeNull();
    expect(await budgetRepo.getKeyReservations(keys.open.id)).toHaveLength(0);
  });

  it("each attempt reserves; a failed member is released before fallback", async () => {
    mocks.handleChatCore.mockImplementation(async ({ modelInfo, budgetReservationId }) => {
      expect(budgetReservationId).toBeTruthy();
      return modelInfo.model === "gpt-4o"
        ? { success: false, status: 500, error: "boom", response: new Response("{}", { status: 500, headers: { "Content-Type": "application/json" } }) }
        : { success: true, response: sse("ok") };
    });
    const r = await chat("Main", keys.rich.key);
    expect(r.status).toBe(200);
    const rows = await budgetRepo.getKeyReservations(keys.rich.id);
    const failed = rows.find((x) => x.model === "gpt-4o");
    expect(failed.status).toBe("released");
    expect(rows.find((x) => x.model === "gpt-4o-mini").status).toBe("reserved");
    await r.text();
  });

  it("a stream whose usage never arrives settles on an estimate after the body ends", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const r = await chat("openai/gpt-4o", keys.rich.key);
    await r.text();
    await vi.advanceTimersByTimeAsync(11_000);
    vi.useRealTimers();
    await flush();
    const row = (await budgetRepo.getKeyReservations(keys.rich.id))[0];
    expect(row.status).toBe("settled");
    expect(row.costSource).toBe("estimated");
    expect(row.actualUsd).toBeGreaterThan(0);
    expect(row.actualUsd).toBeLessThanOrEqual(row.reservedUsd);
  });

  it("a stream with frames but no generated content (combo empty-failover discard) is released, not charged", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const ROLE_ONLY = `data: {"choices":[{"delta":{"role":"assistant"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n`;
    mocks.handleChatCore.mockImplementation(async () => ({
      success: true,
      response: new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(ROLE_ONLY)); } }), { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    }));
    const r = await chat("openai/gpt-4o", keys.rich.key);
    const reader = r.body.getReader();
    await reader.read();
    await reader.cancel("discarded");
    await vi.advanceTimersByTimeAsync(11_000);
    vi.useRealTimers();
    await flush();
    expect((await budgetRepo.getKeyReservations(keys.rich.id))[0].status).toBe("released");
  });

  it("client cancel before any byte releases the reservation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    mocks.handleChatCore.mockImplementation(async () => ({
      success: true,
      response: new Response(new ReadableStream({ pull() { /* never yields */ } }), { status: 200 }),
    }));
    const r = await chat("openai/gpt-4o", keys.rich.key);
    await r.body.cancel("client gone");
    await vi.advanceTimersByTimeAsync(11_000);
    vi.useRealTimers();
    await flush();
    expect((await budgetRepo.getKeyReservations(keys.rich.id))[0].status).toBe("released");
  });

  // gpt-4o output $10/M. Translators raise max_tokens (tools → 32000, thinking →
  // budget+1024), so the reservation must cover the raised value, never the client's.
  // claude-sonnet-4-6: $15/M output, maxOutput 128000 — high enough that the
  // translator floors are not hidden by the model ceiling.
  const SONNET = "claude/claude-sonnet-4-6";
  const OUT_SONNET = 15 / 1e6;
  const reservedFor = async (budget, extra, model = "openai/gpt-4o") => {
    const k = await db.createApiKey(`r-${Math.random()}`, "m1", budget);
    const r = await chat(model, k.key, extra);
    await r.text?.();
    return { status: r.status, reserved: (await budgetRepo.getKeyReservations(k.id))[0]?.reservedUsd ?? 0 };
  };

  it("reserves the whole request or denies it — max_tokens is never lowered to fit", async () => {
    const ok = await reservedFor(1, { max_tokens: 1000 });
    expect(ok.status).toBe(200);
    expect(mocks.handleChatCore.mock.calls.at(-1)[0].body.max_tokens).toBe(1000);
    expect(ok.reserved).toBeGreaterThanOrEqual(1000 * 10 / 1e6);
    // 1000 output tokens = $0.01; $0.005 left is not enough → 429, no provider call.
    const calls = mocks.handleChatCore.mock.calls.length;
    expect((await reservedFor(0.005, { max_tokens: 1000 })).status).toBe(429);
    expect(mocks.handleChatCore.mock.calls.length).toBe(calls);
  });

  it("tools raise the reservation to the translator's 32000-token floor", async () => {
    const tools = [{ type: "function", function: { name: "f", parameters: { type: "object" } } }];
    const { status, reserved } = await reservedFor(5, { max_tokens: 500, tools }, SONNET);
    expect(status).toBe(200);
    expect(reserved).toBeGreaterThanOrEqual(32000 * OUT_SONNET);
    // $0.30 covers 500 tokens but not the 32000 the upstream may produce.
    expect((await reservedFor(0.3, { max_tokens: 500, tools }, SONNET)).status).toBe(429);
  });

  it("thinking budget raises the reservation to budget_tokens + 1024", async () => {
    const { reserved } = await reservedFor(5, { max_tokens: 500, thinking: { type: "enabled", budget_tokens: 20000 } }, SONNET);
    expect(reserved).toBeGreaterThanOrEqual(21024 * OUT_SONNET);
  });

  it("the floor never exceeds the model's own output ceiling (gpt-4o: 16384)", async () => {
    const tools = [{ type: "function", function: { name: "f", parameters: { type: "object" } } }];
    const { reserved } = await reservedFor(5, { max_tokens: 500, tools });
    expect(reserved).toBeGreaterThanOrEqual(16384 * 10 / 1e6);
    expect(reserved).toBeLessThan(32000 * 10 / 1e6);
  });

  it("a request without an output cap gets the cap it was reserved for", async () => {
    await reservedFor(1, { max_tokens: undefined });
    expect(mocks.handleChatCore.mock.calls.at(-1)[0].body.max_tokens).toBeGreaterThan(0);
  });

  it("unpriced model is refused for budget-limited keys (fail closed)", async () => {
    const r = await chat("openai/totally-unknown-model-xyz", keys.rich.key);
    expect(r.status).toBe(403);
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });

  it("paused key with a budget is refused", async () => {
    const k = await db.createApiKey("paused", "m1", 10);
    await db.updateApiKey(k.id, { isActive: false });
    expect((await chat("openai/gpt-4o", k.key)).status).toBe(401);
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
  });

  it("a small cap in one field cannot hide a large one in another (max_completion_tokens:1 + max_tokens:128000)", async () => {
    const { reserved } = await reservedFor(5, { max_completion_tokens: 1, max_tokens: 100000 }, SONNET);
    expect(reserved).toBeGreaterThanOrEqual(100000 * OUT_SONNET);
  });

  it("cursor's fixed 32000-token cap is reserved even when the client asks for 1", async () => {
    await db.updatePricing({ cursor: { "cursor-test-model": { input: 1, output: 10 } } });
    const k = await db.createApiKey("cur", "m1", 5);
    await (await chat("cursor/cursor-test-model", k.key, { max_tokens: 1 })).text();
    const [row] = await budgetRepo.getKeyReservations(k.id);
    expect(row.reservedUsd).toBeGreaterThanOrEqual(32000 * 10 / 1e6);
  });

  it("CJK prompts without spaces count as real input, not as a base64 blob", async () => {
    const cjk = "这是一个很长的中文提示没有任何空格".repeat(400); // ~6.8k chars, no whitespace
    const { reserved: withCjk } = await reservedFor(5, { max_tokens: 10, messages: [{ role: "user", content: cjk }] });
    const { reserved: base } = await reservedFor(5, { max_tokens: 10 });
    // gpt-4o input $2.5/M: ~6.8k CJK tokens ≈ $0.017 more than the tiny prompt.
    expect(withCjk - base).toBeGreaterThan(6000 * 2.5 / 1e6);
  });

  it("a real base64 image still counts as a bounded blob", async () => {
    const img = `data:image/png;base64,${"iVBORw0KGgo".repeat(20000)}`; // ~220k chars
    const { reserved } = await reservedFor(5, { max_tokens: 10, messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: img } }] }] });
    expect(reserved).toBeLessThan(10000 * 2.5 / 1e6);
  });

  it("executors that strip the output cap (codex) reserve the model ceiling, not the client's max_tokens", async () => {
    await db.updatePricing({ codex: { "gpt-5.6-sol": { input: 1, output: 10 } } });
    const k = await db.createApiKey("cx", "m1", 5);
    await (await chat("codex/gpt-5.6-sol", k.key, { max_tokens: 10 })).text();
    const [row] = await budgetRepo.getKeyReservations(k.id);
    expect(row.reservedUsd).toBeGreaterThanOrEqual(128000 * 10 / 1e6);
  });

  it("concurrent requests never reserve past the budget", async () => {
    const k = await db.createApiKey("race", "m1", 0.01);
    const results = await Promise.all(Array.from({ length: 20 }, () => chat("openai/gpt-4o", k.key, { max_tokens: 200 })));
    const d = await today(k);
    expect(d.spentUsd + d.reservedUsd).toBeLessThanOrEqual(0.01 + 1e-12);
    expect(results.some((r) => r.status === 429)).toBe(true);
    expect(mocks.handleChatCore.mock.calls.length).toBe(results.filter((r) => r.status === 200).length);
  });
});

describe("unmetered endpoints are closed to budget-limited keys", () => {
  // The middleware allow-list (dashboard-guard.test.js) refuses /v1/embeddings
  // etc. Gemini native TTS shares the metered /v1beta generateContent path, so
  // it is refused inside the route.
  it("Gemini native TTS: 403 for a budget key sent as x-goog-api-key", async () => {
    const req = new Request("http://localhost/v1beta/models/gemini-2.5-flash-preview-tts:generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": keys.rich.key },
      body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }], generationConfig: { responseModalities: ["AUDIO"] } }),
    });
    const r = await geminiRoute.POST(req, { params: Promise.resolve({ path: ["gemini-2.5-flash-preview-tts:generateContent"] }) });
    expect(r.status).toBe(403);
  });
});
