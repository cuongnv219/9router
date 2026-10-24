// Per-API-key daily USD budget: atomic reservation ledger (real SQLite in a temp
// DATA_DIR), Vietnam-calendar day boundary, exactly-once settlement, and the
// cross-process hard limit.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

// The DB adapter is a process-wide singleton (global._dbAdapter), so the file is
// opened once; each test isolates itself with its own key id.
const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let budget;
let KEY;
let seq = 0;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-budget-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  budget = await import("@/lib/db/repos/budgetRepo.js");
});

beforeEach(() => { KEY = `key-${++seq}`; });

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const reserve = (amount, extra = {}) => budget.reserveBudget({ apiKeyId: KEY, budgetUsd: 1, minUsd: amount, maxUsd: amount, provider: "openai", model: "gpt-4", ...extra });
const invariant = async (k = KEY) => {
  const d = await budget.getBudgetDay(k);
  expect(d.spentUsd + d.reservedUsd).toBeLessThanOrEqual(1 + 1e-9);
  return d;
};

describe("budgetDay — Asia/Ho_Chi_Minh calendar", () => {
  it("flips at 17:00 UTC (= 00:00 UTC+7), not at server midnight", () => {
    expect(budget.budgetDay(new Date("2026-10-24T16:59:59Z"))).toBe("2026-10-24");
    expect(budget.budgetDay(new Date("2026-10-24T17:00:00Z"))).toBe("2026-10-25");
  });

  it("Retry-After points at the next Vietnam midnight", () => {
    expect(budget.secondsUntilNextBudgetDay(new Date("2026-10-24T16:59:00Z"))).toBe(60);
    expect(budget.secondsUntilNextBudgetDay(new Date("2026-10-24T17:00:00Z"))).toBe(86400);
  });
});

describe("reserveBudget / settleBudget", () => {
  it("admits while budget remains and denies once exhausted", async () => {
    const a = await reserve(0.6);
    expect(a.ok).toBe(true);
    await budget.settleBudget({ reservationId: a.reservationId, actualUsd: 0.6 });
    expect((await reserve(0.6)).ok).toBe(false);
    expect((await reserve(0.4)).ok).toBe(true);
    expect((await reserve(0.01)).ok).toBe(false);
    await invariant();
  });

  it("grants a partial reservation when the rest of the day still covers minUsd", async () => {
    await budget.settleBudget({ reservationId: (await reserve(0.9)).reservationId, actualUsd: 0.9 });
    const r = await budget.reserveBudget({ apiKeyId: KEY, budgetUsd: 1, minUsd: 0.05, maxUsd: 0.5 });
    expect(r.ok).toBe(true);
    expect(r.reservedUsd).toBeCloseTo(0.1, 9);
    expect((await budget.reserveBudget({ apiKeyId: KEY, budgetUsd: 1, minUsd: 0.05, maxUsd: 0.5 })).ok).toBe(false);
  });

  it("grants the exact remainder despite float rounding (0.3 - 0.1 - 0.1)", async () => {
    await budget.settleBudget({ reservationId: (await budget.reserveBudget({ apiKeyId: KEY, budgetUsd: 0.3, minUsd: 0.1 })).reservationId, actualUsd: 0.1 });
    expect((await budget.reserveBudget({ apiKeyId: KEY, budgetUsd: 0.3, minUsd: 0.1 })).ok).toBe(true);
    const r = await budget.reserveBudget({ apiKeyId: KEY, budgetUsd: 0.3, minUsd: 0.05, maxUsd: 0.5 });
    expect(r.ok).toBe(true);
    expect(r.reservedUsd).toBeCloseTo(0.1, 9);
  });

  it("settles exactly once: repeated / concurrent settles do not double charge", async () => {
    const r = await reserve(0.5);
    await Promise.all([
      budget.settleBudget({ reservationId: r.reservationId, actualUsd: 0.3 }),
      budget.settleBudget({ reservationId: r.reservationId, actualUsd: 0.3 }),
      budget.settleBudget({ reservationId: r.reservationId, actualUsd: 0, costSource: "released" }),
    ]);
    const d = await invariant();
    expect(d.spentUsd).toBeCloseTo(0.3, 9);
    expect(d.reservedUsd).toBeCloseTo(0, 9);
  });

  it("late real usage after an estimated settle books only the difference", async () => {
    const r = await reserve(0.5);
    await budget.settleBudget({ reservationId: r.reservationId, actualUsd: 0.2, costSource: "estimated" });
    await budget.settleBudget({ reservationId: r.reservationId, actualUsd: 0.25, costSource: "provider_usage" });
    await budget.settleBudget({ reservationId: r.reservationId, actualUsd: 0.25, costSource: "provider_usage" });
    expect((await budget.getBudgetDay(KEY)).spentUsd).toBeCloseTo(0.25, 9);
  });

  it("released reservation returns its budget", async () => {
    const r = await reserve(0.9);
    expect((await reserve(0.2)).ok).toBe(false);
    await budget.settleBudget({ reservationId: r.reservationId, actualUsd: 0, costSource: "released" });
    expect((await reserve(0.2)).ok).toBe(true);
  });

  it("keys have independent budgets", async () => {
    await budget.settleBudget({ reservationId: (await reserve(1)).reservationId, actualUsd: 1 });
    expect((await reserve(0.1)).ok).toBe(false);
    expect((await reserve(0.1, { apiKeyId: `${KEY}-other` })).ok).toBe(true);
  });

  it("50 concurrent reservations never exceed the budget", async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => reserve(0.03)));
    expect(results.filter((r) => r.ok)).toHaveLength(33);
    await invariant();
  });

  it("request spanning midnight is charged to the day it was admitted on; next day starts at 0", async () => {
    const before = new Date("2026-10-24T16:59:59Z");
    const r = await reserve(0.5, { at: before });
    await budget.settleBudget({ reservationId: r.reservationId, actualUsd: 0.4, at: new Date("2026-10-24T17:00:05Z") });
    expect((await budget.getBudgetDay(KEY, "2026-10-24")).spentUsd).toBeCloseTo(0.4, 9);
    expect((await budget.getBudgetDay(KEY, "2026-10-25")).spentUsd).toBe(0);
    expect((await reserve(0.9, { at: new Date("2026-10-24T17:00:06Z") })).ok).toBe(true);
    // History of the previous day survives.
    expect((await budget.getBudgetDays(KEY)).map((d) => d.day)).toEqual(["2026-10-25", "2026-10-24"]);
  });

  it("a reservation abandoned past its TTL is charged in full, not refunded", async () => {
    const t0 = new Date("2026-10-24T05:00:00Z");
    await reserve(0.7, { at: t0 });
    const later = await reserve(0.5, { at: new Date(t0.getTime() + 31 * 60 * 1000) });
    expect(later.ok).toBe(false);
    const d = await budget.getBudgetDay(KEY, "2026-10-24");
    expect(d.spentUsd).toBeCloseTo(0.7, 9);
    expect(d.reservedUsd).toBeCloseTo(0, 9);
  });

  it("saveRequestUsage settles the reservation with the real cost in its own transaction", async () => {
    const r = await reserve(0.5);
    await db.saveRequestUsage({
      provider: "openai", model: "gpt-4", tokens: { prompt_tokens: 1000, completion_tokens: 1000 },
      budgetReservationId: r.reservationId,
    });
    const [row] = await budget.getKeyReservations(KEY);
    expect(row.status).toBe("settled");
    expect(row.costSource).toBe("provider_usage");
    expect(row.actualUsd).toBeGreaterThan(0);
    expect((await budget.getBudgetDay(KEY)).spentUsd).toBeCloseTo(row.actualUsd, 9);
  });

  it("4 processes on the same DB file cannot overspend", async () => {
    const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
    const runs = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
      const child = fork(path.join(fixtures, "budget-reserve-worker.mjs"), [tempDir, "25", "0.03"], {
        stdio: ["ignore", "pipe", "inherit", "ipc"],
        execArgv: ["--import", pathToFileURL(path.join(fixtures, "alias-loader.mjs")).href],
        env: { ...process.env, DATA_DIR: tempDir },
      });
      let out = "";
      child.stdout.on("data", (c) => { out += c; });
      child.on("exit", (code) => (code === 0 ? resolve(Number(out.trim())) : reject(new Error(`worker exit ${code}`))));
    })));
    expect(runs.reduce((a, b) => a + b, 0)).toBe(33);
    await invariant("mp-key");
  }, 60_000);
});
