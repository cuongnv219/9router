# Per-Key Daily USD Budget

Share one 9Router with several people, each with their own API key and their own daily spend limit in USD. When the limit is reached the key is hard-stopped (HTTP 429) until 00:00 Vietnam time.

---

## Overview

- **One budget per key**: budgets are never shared between keys.
- **Budget days follow Vietnam time** (Asia/Ho_Chi_Minh, UTC+7). Reset is at 00:00, independent of the server clock or when the key was created.
- **Hard stop before the provider call**: a refused request spends no tokens.
- **Safe under concurrency**: parallel requests on one key cannot exceed the limit, and fallback to another account or model cannot get around it.
- **History is kept**: every day is its own record; a new day starts at $0.

Keys without a budget behave exactly as before (unlimited).

---

## Set a budget on a key

```
Dashboard → Endpoint → API Keys
```

1. Create a key (or pick an existing one) and name it after its user, e.g. `alice-dev`.
2. Click **Set budget**, enter USD per day (e.g. `5`), click **Save**.
3. Give the key to the user.

Each key shows:

```
Today $1.2300 / $5.0000 (25%)  · left $3.7700  · $0.4000 in flight
████░░░░░░░░░░░░
```

- **Today**: spent plus amounts held for requests still running.
- **left**: what remains today.
- **in flight**: money held for running requests; the unused part is returned when they finish.

To remove the limit: **Edit**, clear the field, **Save**.
To suspend a key: switch it off (Pause). To revoke it: delete the key. Its spend history is kept.

### History

Click **History** on a key to see:

- **By day**: spend and request count per day.
- **By model**: spend per provider/model for the day.
- **Requests**: each request with time, model, status and cost.

Status column:

| Value | Meaning |
|---|---|
| `provider_usage` | Charged from the usage the provider reported |
| `estimated` | No usage reported (client disconnected, error mid-stream), so charged on an estimate |
| `provider_usage_late` | Real usage arrived after an estimate; only the difference was added |
| `released` | Request failed or generated nothing; not charged |
| `expired` | Request hung for over 30 minutes (crash, etc.); the full held amount is charged |

---

## How charging works

### Before the provider call: hold

For every provider call, 9Router first **holds** the most the request could cost:

```
hold = estimated input × input price + maximum output × output price
```

The maximum output is **not** always the client's `max_tokens`, because some translators and providers raise it:

| Case | Maximum output held |
|---|---|
| Plain request | client's `max_tokens` (64000 if absent) |
| Has `tools` (Claude Code, Cursor, Cline…) | at least **32000** |
| Has a thinking `budget_tokens` | at least `budget_tokens + 1024` |
| Has a reasoning effort | the model's maximum output |
| Codex, grok-cli (ignore `max_tokens`) | the model's maximum output |

It is always capped at the model's maximum output (e.g. gpt-4o: 16384).

If the remaining budget cannot cover the hold, the request gets **429** and the provider is not called.

### After the response: charge the real cost

The real cost comes from the usage the provider reports and the **Pricing** table (input, output, cached, cache creation, reasoning). The unused part of the hold is returned immediately.

### Example

$5/day key, model `claude-sonnet-4-6` ($15/M output), request with tools:

```
hold ≈ 32000 × $15/M = $0.48 (+ input)
real cost (2000 output tokens) ≈ $0.03 (+ input)
→ returned ≈ $0.45
```

> **Note:** because a tool request holds up to ~$0.48, once less than that is left for the day, tool requests get 429 even though the balance is not zero. This trade-off is deliberate: the limit is **never exceeded**.

### Requests that span midnight

A request that starts at 23:59 and ends at 00:01 is charged to the **day it started** (the day that admitted it).

---

## When the budget runs out

The client receives:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 18727
X-Budget-Day: 2026-10-24

{
  "error": {
    "message": "Daily budget exhausted for this API key: $4.9500 spent + $0.0000 in flight of $5.00 (resets 00:00 Asia/Ho_Chi_Minh)",
    "type": "rate_limit_error",
    "code": "daily_budget_exceeded"
  }
}
```

`Retry-After` is the number of seconds until 00:00 Vietnam time. Tools such as Claude Code report a rate-limit error; the user waits for the next day or asks the admin to raise the budget (takes effect immediately for new requests).

---

## Restrictions on budget-limited keys

So that nothing can spend without being charged, a key with a budget can **only** call the chat endpoints:

| Allowed | Refused (403) |
|---|---|
| `/v1/chat/completions` | `/v1/embeddings` |
| `/v1/messages` | `/v1/images/generations` |
| `/v1/responses` | `/v1/audio/speech`, `/v1/audio/transcriptions` |
| `/v1beta/models/...:generateContent` | `/v1/videos/*` |
| `/v1/api/chat` (Ollama) | `/v1/search`, `/v1/web/fetch` |
| `GET /v1/models` | `/v1/systemone`, Gemini native TTS |

Also:

- **Models without a price** (or priced at $0) are refused with 403. To allow one, set its price under **Pricing**.
- **Smart Router combos** still work, but skip the System One model-selection step (that step is an unmetered provider call) and follow combo order.

Need a refused endpoint? Use a key **without** a budget for it.

---

## Any key header works

The budget applies the same whether the key is sent as `Authorization: Bearer`, `x-api-key`, `x-goog-api-key` or `?key=`.

---

## Admin API

All of these require a dashboard session (or the CLI token).

```bash
# Create a key with a $5/day budget
curl -X POST http://localhost:20128/api/keys \
  -H "Content-Type: application/json" -b "auth_token=..." \
  -d '{"name":"alice-dev","dailyBudgetUsd":5}'

# Change budget / name / pause (null = unlimited)
curl -X PUT http://localhost:20128/api/keys/<id> \
  -H "Content-Type: application/json" -b "auth_token=..." \
  -d '{"dailyBudgetUsd":10,"name":"alice","isActive":true}'

# Spend by day, by model and per request (day=YYYY-MM-DD, default today)
curl "http://localhost:20128/api/keys/<id>/usage?day=2026-10-24" -b "auth_token=..."

# Admin audit log (key create / update / delete)
curl "http://localhost:20128/api/audit-log" -b "auth_token=..."
```

`GET /api/keys` includes `budget` (`spentUsd`, `reservedUsd`, `remainingUsd`, `requests`) for keys with a budget.

---

## Operating notes

- **Single host.** The limit is exact when 9Router runs on one machine with native SQLite (Node ≥ 22.5 or Bun). It is not guaranteed on the `sql.js` fallback or with several machines sharing one DB file.
- **Input estimate.** Input is estimated up front from the request size; if the real input is much larger (e.g. many images) or the provider reports no usage, a day can end slightly over the limit.
- **Prices.** Cost comes from the **Pricing** table. Subscription/OAuth providers are charged at the equivalent list price: a measure for sharing capacity, not a real invoice.
- **Security.** With `requireLogin` off, anyone who can reach the dashboard can edit budgets. When you hand keys to other people, keep login on and change the default password.
