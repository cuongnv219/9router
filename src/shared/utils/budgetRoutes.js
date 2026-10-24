// Which /v1 routes a budget-limited API key may call. ALLOW-list on purpose:
// only routes that go through the chat handler's per-attempt reservation
// (src/sse/services/budget.js) can be metered, so any inference route not
// named here — including routes added later — is refused for such keys by the
// middleware before its handler runs. Read-only catalog GETs stay open.
//
// Paths are the ones the middleware sees (before next.config rewrites).
const METERED_POST_ROUTES = [
  /^\/(api\/)?v1\/chat\/completions\/?$/,
  /^\/(api\/)?v1\/messages\/?$/,
  /^\/(api\/)?v1\/messages\/count_tokens\/?$/, // local estimate, no provider call
  /^\/(api\/)?v1\/responses(\/compact)?\/?$/,
  /^\/(api\/)?v1\/api\/chat\/?$/, // Ollama-compatible → handleChat
  /^\/responses\/?$/,
  /^\/codex(\/.*)?$/,
  // Gemini generateContent → handleChat. Native TTS on the same path is refused
  // inside the route (denyBudgetKeyOnUnmeteredEndpoint).
  /^\/(api\/)?v1beta\/models\/.+:(stream)?[gG]enerateContent$/,
];

export const UNMETERED_ENDPOINT_MESSAGE = "This endpoint is not available for budget-limited API keys";

export function isBudgetMeteredRoute(method, pathname) {
  const m = String(method || "GET").toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return true;
  return m === "POST" && METERED_POST_ROUTES.some((re) => re.test(pathname));
}
