// Validate an admin-supplied daily budget. null/"" = unlimited.
const MAX_DAILY_BUDGET_USD = 1_000_000;

export function parseDailyBudget(value) {
  if (value === null || value === "") return { ok: true, value: null };
  const n = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > MAX_DAILY_BUDGET_USD) {
    return { ok: false, error: `dailyBudgetUsd must be null or a number between 0 and ${MAX_DAILY_BUDGET_USD}` };
  }
  return { ok: true, value: Math.round(n * 1e6) / 1e6 };
}
