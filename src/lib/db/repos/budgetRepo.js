// Per-API-key daily USD budget: ledger + atomic reservation.
//
// The invariant `spentUsd + reservedUsd <= dailyBudgetUsd` is enforced by the
// conditional UPDATE in reserve(), not by a check in JS: a request is admitted
// only if SQLite itself could apply the row update. Concurrent requests on one
// key therefore cannot each pass a stale read and overspend together.
//
// Each attempt reserves an estimate BEFORE the provider call and settles the
// real cost after. settle() flips the row out of 'reserved' in the same
// statement that applies the money, so a double settle (stream end + abort,
// retry paths) is a no-op rather than a double charge.
import { getAdapter } from "../driver.js";

// Budget days are calendar days in Vietnam, independent of the server clock's
// zone. en-CA renders as YYYY-MM-DD.
export const BUDGET_TZ = "Asia/Ho_Chi_Minh";
const dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUDGET_TZ, year: "numeric", month: "2-digit", day: "2-digit",
});

export function budgetDay(at = new Date()) {
  return dayFmt.format(at);
}

// Seconds until the next Vietnam midnight — the Retry-After for a 429.
// ponytail: fixed +07:00 offset (Vietnam has no DST); derive it from BUDGET_TZ if the zone becomes configurable.
export function secondsUntilNextBudgetDay(at = new Date()) {
  const nextMidnight = Date.parse(`${budgetDay(at)}T00:00:00+07:00`) + 86400_000;
  return Math.max(1, Math.ceil((nextMidnight - at.getTime()) / 1000));
}

// A reservation left open past this is treated as spent, not released: the
// request is gone (crash, swallowed write) and we must not hand its budget back
// to a key that may already have used it. Stream stall timeout is 360s.
const RESERVATION_TTL_MS = 30 * 60 * 1000;
const BUDGET_EPS_USD = 1e-9;

function expireStale(db, apiKeyId, nowMs) {
  const cutoff = new Date(nowMs - RESERVATION_TTL_MS).toISOString();
  const stale = db.all(
    `SELECT id, day, reservedUsd FROM apiKeyReservations
      WHERE apiKeyId = ? AND status = 'reserved' AND createdAt < ?`,
    [apiKeyId, cutoff]
  );
  for (const r of stale) {
    db.run(
      `UPDATE apiKeyReservations SET status = 'expired', actualUsd = reservedUsd,
         costSource = 'expired', settledAt = ? WHERE id = ? AND status = 'reserved'`,
      [new Date(nowMs).toISOString(), r.id]
    );
    db.run(
      `UPDATE apiKeyBudgetDays SET reservedUsd = MAX(0, reservedUsd - ?), spentUsd = spentUsd + ?
        WHERE apiKeyId = ? AND day = ?`,
      [r.reservedUsd, r.reservedUsd, apiKeyId, r.day]
    );
  }
  return stale.length;
}

/**
 * Reserve between `minUsd` and `maxUsd` against today's budget: the full
 * `maxUsd` when it fits, else whatever is left as long as that covers `minUsd`.
 * So the last dollars of a day stay usable without letting reservations exceed
 * the budget. Denied when nothing is left.
 * @returns {Promise<{ok: true, reservationId, reservedUsd, remainingUsd, day}
 *                  | {ok: false, spentUsd, reservedUsd, budgetUsd, day}>}
 */
export async function reserveBudget({ apiKeyId, budgetUsd, minUsd = 0, maxUsd = minUsd, provider, model, endpoint, at = new Date() }, db = null) {
  db ||= await getAdapter();
  const day = budgetDay(at);
  const nowIso = at.toISOString();
  const lo = Math.max(0, Number(minUsd) || 0);
  const hi = Math.max(lo, Number(maxUsd) || 0);
  const id = `${at.getTime()}-${Math.random().toString(36).slice(2, 11)}`;
  const readDay = () => db.get(`SELECT spentUsd, reservedUsd FROM apiKeyBudgetDays WHERE apiKeyId = ? AND day = ?`, [apiKeyId, day]);

  return db.transaction(() => {
    db.run(
      `INSERT INTO apiKeyBudgetDays(apiKeyId, day, spentUsd, reservedUsd, requests)
       VALUES(?, ?, 0, 0, 0) ON CONFLICT(apiKeyId, day) DO NOTHING`,
      [apiKeyId, day]
    );
    expireStale(db, apiKeyId, at.getTime());

    const before = readDay();
    const remaining = budgetUsd - before.spentUsd - before.reservedUsd;
    const denied = { ok: false, day, budgetUsd, spentUsd: before.spentUsd, reservedUsd: before.reservedUsd };
    if (remaining <= 0 || remaining + BUDGET_EPS_USD < lo) return denied;
    const amount = Math.min(hi, remaining);

    // The guard lives in WHERE, not in the JS check above: another process
    // writing the same file serializes on the row, and the loser matches nothing.
    // + EPS: `amount` may be the exact remainder computed in JS doubles; re-adding
    // it in SQL can land one ulp above budgetUsd. A billionth of a cent is noise.
    const res = db.run(
      `UPDATE apiKeyBudgetDays SET reservedUsd = reservedUsd + ?, requests = requests + 1
        WHERE apiKeyId = ? AND day = ? AND spentUsd + reservedUsd + ? <= ? + ${BUDGET_EPS_USD}`,
      [amount, apiKeyId, day, amount, budgetUsd]
    );
    if ((res?.changes ?? 0) !== 1) return denied;

    db.run(
      `INSERT INTO apiKeyReservations(id, apiKeyId, day, status, reservedUsd, provider, model, endpoint, createdAt)
       VALUES(?, ?, ?, 'reserved', ?, ?, ?, ?, ?)`,
      [id, apiKeyId, day, amount, provider || null, model || null, endpoint || null, nowIso]
    );
    return { ok: true, reservationId: id, day, reservedUsd: amount, remainingUsd: remaining - amount };
  });
}

/**
 * Settle a reservation exactly once. Later calls for the same id are ignored,
 * except that a real provider cost arriving after an estimated settle books the
 * difference (never a second full charge).
 * @param {"provider_usage"|"estimated"|"released"} costSource
 */
export async function settleBudget(args) {
  if (!args?.reservationId) return { settled: false };
  const db = await getAdapter();
  return db.transaction(() => settleInTx(db, args));
}

// Synchronous body of settleBudget, for callers already inside db.transaction
// (saveRequestUsage settles in the same transaction that writes the usage row).
export function settleInTx(db, { reservationId, actualUsd, costSource = "provider_usage", tokens = null, at = new Date() }) {
  if (!reservationId) return { settled: false };
  const nowIso = at.toISOString();

  const row = db.get(`SELECT * FROM apiKeyReservations WHERE id = ?`, [reservationId]);
  if (!row) return { settled: false };
  // Finite cap on whatever the caller computed (NaN/negative → 0).
  const actual = Math.max(0, Number.isFinite(Number(actualUsd)) ? Number(actualUsd) : 0);

  if (row.status !== "reserved") {
    // Late real usage after an estimated/expired settle: book only the delta.
    const isLate = costSource === "provider_usage" && !String(row.costSource).startsWith("provider_usage");
    const delta = actual - (row.actualUsd ?? 0);
    if (!isLate || delta <= 0) return { settled: false };
    db.run(
      `UPDATE apiKeyReservations SET actualUsd = ?, costSource = 'provider_usage_late', settledAt = ? WHERE id = ?`,
      [actual, nowIso, reservationId]
    );
    db.run(`UPDATE apiKeyBudgetDays SET spentUsd = spentUsd + ? WHERE apiKeyId = ? AND day = ?`, [delta, row.apiKeyId, row.day]);
    return { settled: true, late: true };
  }

  const upd = db.run(
    `UPDATE apiKeyReservations
        SET status = ?, actualUsd = ?, costSource = ?, settledAt = ?,
            promptTokens = ?, completionTokens = ?, cachedTokens = ?
      WHERE id = ? AND status = 'reserved'`,
    [
      costSource === "released" ? "released" : "settled",
      actual, costSource, nowIso,
      tokens?.prompt_tokens ?? null, tokens?.completion_tokens ?? null, tokens?.cached_tokens ?? null,
      reservationId,
    ]
  );
  if ((upd?.changes ?? 0) !== 1) return { settled: false };

  // Charged to the day the reservation was made on, even if it settles after
  // midnight: that is the day whose limit admitted it.
  db.run(
    `UPDATE apiKeyBudgetDays SET reservedUsd = MAX(0, reservedUsd - ?), spentUsd = spentUsd + ?
      WHERE apiKeyId = ? AND day = ?`,
    [row.reservedUsd, actual, row.apiKeyId, row.day]
  );
  return { settled: true };
}

export async function getBudgetDay(apiKeyId, day = budgetDay()) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeyBudgetDays WHERE apiKeyId = ? AND day = ?`, [apiKeyId, day]);
  return { apiKeyId, day, spentUsd: row?.spentUsd ?? 0, reservedUsd: row?.reservedUsd ?? 0, requests: row?.requests ?? 0 };
}

export async function getBudgetDays(apiKeyId, { from, to } = {}) {
  const db = await getAdapter();
  const conds = ["apiKeyId = ?"];
  const params = [apiKeyId];
  if (from) { conds.push("day >= ?"); params.push(from); }
  if (to) { conds.push("day <= ?"); params.push(to); }
  return db.all(`SELECT * FROM apiKeyBudgetDays WHERE ${conds.join(" AND ")} ORDER BY day DESC`, params);
}

export async function getKeyReservations(apiKeyId, { day, limit = 100, offset = 0 } = {}) {
  const db = await getAdapter();
  const conds = ["apiKeyId = ?"];
  const params = [apiKeyId];
  if (day) { conds.push("day = ?"); params.push(day); }
  params.push(Math.min(500, Math.max(1, limit)), Math.max(0, offset));
  return db.all(
    `SELECT * FROM apiKeyReservations WHERE ${conds.join(" AND ")} ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
    params
  );
}

// Spend per provider/model for one key-day. In-flight rows count at their reservation.
export async function getKeyModelBreakdown(apiKeyId, day) {
  const db = await getAdapter();
  return db.all(
    `SELECT provider, model, COUNT(*) AS requests, SUM(COALESCE(actualUsd, reservedUsd)) AS costUsd
       FROM apiKeyReservations WHERE apiKeyId = ? AND day = ? AND status != 'released'
      GROUP BY provider, model ORDER BY costUsd DESC`,
    [apiKeyId, day]
  );
}

export async function logAdminAction(action, targetId = null, detail = null) {
  try {
    const db = await getAdapter();
    db.run(`INSERT INTO adminAuditLog(at, action, targetId, detail) VALUES(?, ?, ?, ?)`, [
      new Date().toISOString(), action, targetId, detail ? JSON.stringify(detail) : null,
    ]);
  } catch { /* audit log must never break the action it records */ }
}

export async function getAdminAuditLog({ limit = 100, offset = 0 } = {}) {
  const db = await getAdapter();
  return db.all(`SELECT * FROM adminAuditLog ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`, [
    Math.min(500, Math.max(1, limit)), Math.max(0, offset),
  ]);
}
