// Per-API-key daily USD budget guard for /v1 inference.
//
// Flow per upstream attempt (one account try, one combo member, one fusion
// panel member):
//   reserveAttempt()  — before the provider call; denies (429) or reserves an
//                       upper-bound estimate and clamps max output to fit it.
//   provider call     — chatCore threads budgetReservationId down to
//                       saveRequestUsage, which settles the real cost in the
//                       same transaction that writes the usage row.
//   guardResponse()   — fallback settle once the body ends, for responses that
//                       never produce usage. Idempotent: the real settle wins.
import { getApiKeyByKey } from "@/lib/db/repos/apiKeysRepo.js";
import { getPricingForModel } from "@/lib/db/repos/pricingRepo.js";
import { reserveBudget, settleBudget, getBudgetDay, secondsUntilNextBudgetDay } from "@/lib/db/repos/budgetRepo.js";
import { calculateCostFromTokens } from "open-sse/providers/pricing.js";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS, DEFAULT_MAX_TOKENS, DEFAULT_MIN_TOKENS } from "open-sse/config/runtimeConfig.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { scanSSEBuffer } from "open-sse/services/emptyFailover.js";
import { extractClientApiKey } from "@/shared/utils/clientApiKey.js";
import { UNMETERED_ENDPOINT_MESSAGE } from "@/shared/utils/budgetRoutes.js";

// How long after a body ends to wait for the real usage write before settling
// the fallback. saveRequestUsage normally lands within milliseconds.
const FALLBACK_SETTLE_MS = 10_000;
// ponytail: chars/3 over the request JSON is a deliberate over-estimate (CJK/Vietnamese run
// denser than English's ~4); swap in a real tokenizer only if over-reservation starts denying requests.
const CHARS_PER_TOKEN = 3;
const INLINE_BLOB_MIN_CHARS = 4096;
const INLINE_BLOB_TOKENS = 1600;

/** The presented key's budget record, or null when the request is not budget-limited. */
export async function resolveBudgetKey(request) {
  const raw = extractClientApiKey(request);
  if (!raw) return null;
  const record = await getApiKeyByKey(raw);
  if (record?.dailyBudgetUsd == null) return null;
  return { id: record.id, name: record.name || record.id, isActive: record.isActive, budgetUsd: Number(record.dailyBudgetUsd) };
}

// Base64 images/files would otherwise dominate the char count and reserve
// hundreds of thousands of phantom tokens.
// Only base64 (optionally as a data: URL) counts as a blob. CJK prose, minified
// JSON or long URLs also lack whitespace but are real tokens and must count in full.
const BASE64_BLOB = /^(data:[\w.+-]+\/[\w.+-]+(;[\w=.+-]+)*;base64,)?[A-Za-z0-9+/_-]+={0,2}$/;
const isInlineBlob = (v) => v.length >= INLINE_BLOB_MIN_CHARS && BASE64_BLOB.test(v);

function estimateInputTokens(body) {
  try {
    const json = JSON.stringify(body, (_k, v) => (
      typeof v === "string" && isInlineBlob(v) ? "x".repeat(INLINE_BLOB_TOKENS * CHARS_PER_TOKEN) : v
    ));
    // CJK and other non-Latin scripts run ~1 token per character, not 1 per 3.
    const nonAscii = json.match(/[^\x00-\x7F]/g)?.length || 0;
    return Math.ceil((json.length - nonAscii) / CHARS_PER_TOKEN) + nonAscii;
  } catch {
    return 0;
  }
}

const OUTPUT_FIELDS = ["max_output_tokens", "max_completion_tokens", "max_tokens"];

// The LARGEST cap the client sent: translators pick different fields
// (openai-to-claude reads max_tokens, Responses reads max_output_tokens), so a
// small value in one field must not hide a large one in another.
function requestedMaxOutput(body) {
  const caps = OUTPUT_FIELDS.map((f) => Number(body?.[f])).filter((v) => Number.isFinite(v) && v > 0);
  return caps.length ? Math.floor(Math.max(...caps)) : null;
}

const hasReasoning = (body, thinkingForced) => thinkingForced
  || (body.thinking && body.thinking.type !== "disabled")
  || (body.reasoning_effort && !["none", "minimal"].includes(body.reasoning_effort))
  || (typeof body.reasoning === "object" && body.reasoning?.effort && body.reasoning.effort !== "none")
  || !!body.output_config?.effort
  || !!(body.thinkingConfig || body.generationConfig?.thinkingConfig);

/**
 * The most output the upstream can be asked for after translation. Translators
 * only ever RAISE the client's cap (adjustMaxTokens lifts tool calls to
 * DEFAULT_MIN_TOKENS, thinking to budget+1024, openai-to-claude ignores
 * max_completion_tokens), so the reservation must cover those floors rather
 * than trust the client's number. Clamped to the model's known output ceiling,
 * which the translators and upstream enforce.
 */
// Executors that DELETE the output cap before calling upstream (Codex rejects
// it; grok-cli drops the Chat fields). For these the client's number is void,
// so the reservation covers the model ceiling.
const OUTPUT_CAP_STRIPPED = new Set(["codex", "grok-cli"]);
// Translators/executors that REPLACE the client's cap with a fixed value
// (openai-to-cursor sends DEFAULT_MIN_TOKENS; antigravity image models 8192).
const OUTPUT_CAP_FIXED = { cursor: DEFAULT_MIN_TOKENS, antigravity: 8192 };

// ponytail: sized from the client body against known translator/executor rules; the exact
// fix is to size the reservation from the post-translation body inside chatCore — do that if a
// new provider rewrites the cap and slips past these tables.
function maxUpstreamOutput(body, provider, model, thinkingForced) {
  const ceiling = getCapabilitiesForModel(provider, model).maxOutput;
  if (OUTPUT_CAP_STRIPPED.has(provider)) return ceiling || DEFAULT_MAX_TOKENS;
  const requested = requestedMaxOutput(body);
  // No cap in ANY field → the upstream default applies (up to DEFAULT_MAX_TOKENS).
  let out = Math.max(requested ?? DEFAULT_MAX_TOKENS, OUTPUT_CAP_FIXED[provider] ?? 0);
  if (Array.isArray(body.tools) && body.tools.length > 0) out = Math.max(out, DEFAULT_MIN_TOKENS);
  const thinkingBudget = Number(body.thinking?.budget_tokens) || 0;
  if (thinkingBudget > 0) out = Math.max(out, thinkingBudget + 1024);
  // Effort levels map to budgets up to the model ceiling.
  else if (hasReasoning(body, thinkingForced)) out = Math.max(out, ceiling || DEFAULT_MAX_TOKENS);
  return Number.isFinite(ceiling) && ceiling > 0 ? Math.min(out, ceiling) : out;
}

// A request with no output cap is unbounded on passthrough upstreams; give it
// the cap the reservation was sized for. Client-set caps are left alone.
function ensureOutputCap(body, tokens) {
  if (OUTPUT_FIELDS.some((f) => body[f] !== undefined)) return;
  body[Array.isArray(body.input) && !Array.isArray(body.messages) ? "max_output_tokens" : "max_tokens"] = tokens;
}

const isBillable = (p) => !!p && (Number(p.input) > 0 || Number(p.output) > 0);

function overBudgetResponse(denied) {
  const retryAfterSec = secondsUntilNextBudgetDay();
  const message = `Daily budget exhausted for this API key: $${denied.spentUsd.toFixed(4)} spent + $${denied.reservedUsd.toFixed(4)} in flight of $${denied.budgetUsd.toFixed(2)} (resets 00:00 Asia/Ho_Chi_Minh)`;
  // Top-level retryAfter: combo.js reads it to keep Retry-After when every member is denied.
  return new Response(JSON.stringify({
    error: { message, type: "rate_limit_error", code: "daily_budget_exceeded" },
    retryAfter: new Date(Date.now() + retryAfterSec * 1000).toISOString(),
  }), {
    status: HTTP_STATUS.RATE_LIMITED,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "retry-after": String(retryAfterSec),
      "X-Budget-Day": denied.day,
    },
  });
}

/**
 * Cheap non-atomic early reject, before combo expansion and the smart router
 * spend anything. The authoritative check is still reserveAttempt().
 */
export async function precheckBudget(budgetKey) {
  if (!budgetKey) return null;
  if (!budgetKey.isActive) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "API key is paused");
  try {
    const d = await getBudgetDay(budgetKey.id);
    if (d.spentUsd + d.reservedUsd >= budgetKey.budgetUsd) {
      return overBudgetResponse({ ...d, budgetUsd: budgetKey.budgetUsd });
    }
  } catch { /* reserveAttempt fails closed on the same error */ }
  return null;
}

/**
 * Reserve budget for one upstream attempt: the full cost of the largest output
 * the upstream can produce, or a 429. Sets an output cap on `body` when the
 * client sent none.
 * @param {boolean} [opts.thinkingForced] - settings inject thinking for this provider
 * @returns {Promise<{reservationId: string|null, estimateUsd?: (bytesOut:number)=>number, denied: Response|null}>}
 */
export async function reserveAttempt(budgetKey, { provider, model, body, endpoint, thinkingForced = false }) {
  if (!budgetKey) return { reservationId: null, denied: null };
  if (!budgetKey.isActive) return { reservationId: null, denied: errorResponse(HTTP_STATUS.UNAUTHORIZED, "API key is paused") };

  let pricing;
  try {
    pricing = await getPricingForModel(provider, model);
  } catch {
    pricing = null;
  }
  // Fail closed: a model we cannot price would spend the budget invisibly.
  // 403 lets a combo advance to a member that is priced.
  if (!isBillable(pricing)) {
    return {
      reservationId: null,
      denied: errorResponse(HTTP_STATUS.FORBIDDEN, `Model ${provider}/${model} has no price configured; budget-limited keys cannot call it. Set a price under Pricing to allow it.`),
    };
  }

  const inputTokens = estimateInputTokens(body);
  const maxOut = maxUpstreamOutput(body, provider, model, thinkingForced);
  const cost = (out) => calculateCostFromTokens({ prompt_tokens: inputTokens, completion_tokens: out }, pricing);
  ensureOutputCap(body, maxOut);

  // ponytail: all-or-nothing — no partial "last dollars" reservation, because a lowered
  // max_tokens does not survive translation (see maxUpstreamOutput). Shrinking output to
  // fit needs a translator-aware clamp applied after translation, inside chatCore.
  let res;
  try {
    res = await reserveBudget({
      apiKeyId: budgetKey.id,
      budgetUsd: budgetKey.budgetUsd,
      minUsd: cost(maxOut),
      provider, model, endpoint,
    });
  } catch (e) {
    // Fail closed: without a reservation we cannot bound spend.
    console.error("[BUDGET] reserve failed:", e?.message || e);
    return { reservationId: null, denied: errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, "Budget ledger unavailable, try again") };
  }
  if (!res.ok) return { reservationId: null, denied: overBudgetResponse(res) };

  // Bytes sent to the client over-count output tokens (SSE/JSON framing), so
  // this errs high; capped at what was reserved.
  const estimateUsd = (bytesOut) => Math.min(res.reservedUsd, cost(Math.ceil(bytesOut / CHARS_PER_TOKEN)));
  return { reservationId: res.reservationId, estimateUsd, denied: null };
}

export function releaseAttempt(reservationId) {
  if (!reservationId) return;
  settleBudget({ reservationId, actualUsd: 0, costSource: "released" }).catch(() => {});
}

// Settle on an estimate when no real usage arrived (client disconnect, upstream
// error mid-stream, provider without usage). Free when no generated content went
// through — e.g. a combo discarding an empty stream after peeking its role/finish
// frames, which are bytes but not output. No-op when the real usage already
// settled; a later real usage books only the difference.
function scheduleFallbackSettle(attempt, bytesOut, sawContent) {
  const { reservationId, estimateUsd } = attempt;
  const timer = setTimeout(() => {
    settleBudget(sawContent
      ? { reservationId, actualUsd: estimateUsd(bytesOut), costSource: "estimated" }
      : { reservationId, actualUsd: 0, costSource: "released" }
    ).catch(() => {});
  }, FALLBACK_SETTLE_MS);
  timer.unref?.();
}

/** Wrap a successful attempt's response so its reservation always settles. */
export function guardResponse(response, attempt) {
  if (!attempt?.reservationId) return response;
  if (!response?.body) {
    scheduleFallbackSettle(attempt, 0, false);
    return response;
  }
  const isSSE = (response.headers?.get?.("content-type") || "").includes("text/event-stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  // Same structural content test the combo's empty-failover uses.
  const scan = { sawContent: false, finishReason: null };
  let text = "";
  let bytesOut = 0;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    // Non-SSE bodies (JSON) settle from their own usage; any bytes count.
    scheduleFallbackSettle(attempt, bytesOut, isSSE ? scan.sawContent : bytesOut > 0);
  };
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { end(); controller.close(); return; }
        bytesOut += value?.byteLength || 0;
        if (isSSE && !scan.sawContent) {
          text += decoder.decode(value, { stream: true });
          scanSSEBuffer(text, scan);
          text = scan.pending || "";
        }
        controller.enqueue(value);
      } catch (e) {
        end();
        controller.error(e);
      }
    },
    cancel(reason) {
      end();
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * Endpoints without a reservation path that a budget-limited key still reaches
 * past the middleware allow-list (src/shared/utils/budgetRoutes.js): Gemini
 * native TTS shares /v1beta with the metered generateContent route. Returns a
 * Response to send, or null to continue.
 */
export async function denyBudgetKeyOnUnmeteredEndpoint(request) {
  const budgetKey = await resolveBudgetKey(request);
  if (!budgetKey) return null;
  return errorResponse(HTTP_STATUS.FORBIDDEN, UNMETERED_ENDPOINT_MESSAGE);
}
