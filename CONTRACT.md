# Reflex contract

The interfaces between the pieces. If you change one, change it here first.

```
Amp ──stdio──> mcp/ (pay tool) ──HTTP──> merchant (MPP 402)       [agent side, local]
                     │
                     └──HTTPS──> supabase reflex-score ──> Turnkey (sign)   [server side]
                                        │
                                        └──> Telegram <── reflex-telegram (buttons)
```

Supabase project ref `zcbflnilhzdwocswluzg`. Function base:
`https://zcbflnilhzdwocswluzg.supabase.co/functions/v1/`. Both functions deploy
with `verify_jwt = false` and do their own auth.

Local `.env` (gitignored) holds `REFLEX_AGENT_KEY`, `REFLEX_ADMIN_KEY`,
`TELEGRAM_WEBHOOK_SECRET`, URLs, and the user's Turnkey/Telegram values.
Server secrets already set: `REFLEX_ADMIN_KEY`, `TELEGRAM_WEBHOOK_SECRET`,
`REFLEX_SIGNER=stub`. Later: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
`TURNKEY_*`, `REFLEX_SIGNER=turnkey`.

## Normalized challenge

The MCP server parses the merchant's MPP 402 (`WWW-Authenticate: Payment ...`)
into this shape and sends it to the scorer. `raw` is the untouched header
value so the scorer can build the real credential.

```ts
type Challenge = {
  id: string;
  realm: string;        // host that issued it
  method: string;       // "tempo" | "stub"
  intent: string;       // "charge"
  amount: string;       // base units, decimal string
  decimals: number;     // 6 for USD stablecoins
  currency: string;     // token address (or "USD" in stub)
  recipient: string;    // 0x address, lowercased
  chainId: number | null;
  expires: string | null; // ISO
  raw: string;          // full WWW-Authenticate header value
};
```

`amount_usd = amount / 10^decimals` (stablecoins only).

## Scorer: `reflex-score`

Auth: header `x-reflex-key: <REFLEX_AGENT_KEY>`. Scorer compares
`sha256(key)` hex to `agents.key_hash`. Admin routes use
`x-reflex-admin: <REFLEX_ADMIN_KEY>`.

`POST /reflex-score/score`
```json
{ "url": "...", "method": "GET", "reason": "string, >= 8 chars", "challenge": Challenge }
```
Responses (200):
```json
{ "decision": "sign", "payment_id": "uuid", "checks": Check[], "credential": "string for Authorization: Payment <credential>" }
{ "decision": "hold", "payment_id": "uuid", "hold_id": "uuid", "checks": Check[], "paused": false }
```
`Check = { "name": "cap"|"payee"|"amount"|"velocity", "pass": boolean, "detail": string }`.
Errors are 4xx `{ "error": string }`. Missing or short `reason` is 400.

`GET /reflex-score/holds/:hold_id`
```json
{ "status": "pending"|"approved"|"denied"|"expired"|"failed", "payment_id": "uuid", "credential"?: "string", "error"?: "string" }
```
When a hold is approved, the first poll signs and returns `credential`; the
payment becomes `signed`. If signing fails (e.g. Turnkey policy), the status is
`failed` with `error`.

`POST /reflex-score/settle` `{ "payment_id", "http_status": number, "receipt"?: string, "tx_hash"?: string }`
The MCP server reports what the merchant said after the paid retry.

`GET /reflex-score/feed?since=<iso>` Returns up to 100 recent payments for this
agent, newest last:
`{ "items": [{ "id", "created_at", "status", "amount_usd", "realm", "recipient", "reason", "failed": string[], "tx_hash" }] }`

`POST /reflex-score/admin/reset` (admin) Clears this demo's payments and holds,
unpauses the agent, and resets the baseline to the seed. Body `{ "agent": "amp-demo" }`.

## Scoring (four checks, all must pass to sign)

1. **cap**: `amount_usd <= per_payment_cap_usd` (25) and today's signed total + amount `<= daily_cap_usd` (100).
2. **payee**: `recipient` is in `baselines` for this agent.
3. **amount**: `amount_usd <= 2 * baselines.max_usd` for that recipient. Pass if no baseline (payee covers it).
4. **velocity**: fewer than `velocity_limit` (10) scored payments in the last `velocity_window_s` (60). On fail, set `agents.paused_at`.

If the agent is paused, every request is held with no new Telegram card. When
velocity first trips, exactly one "paused" card is sent.
Scoring runs in a transaction holding a per-agent row lock, so concurrent calls
can't slip past the caps.

## Telegram: `reflex-telegram`

Telegram calls it with header `X-Telegram-Bot-Api-Secret-Token: <TELEGRAM_WEBHOOK_SECRET>`.
Reject anything else. Only callbacks from `TELEGRAM_CHAT_ID` count.

Callback data: `approve:<hold_id>`, `deny:<hold_id>`, `resume:<agent_id>`, `keep:<agent_id>`.
- approve: hold becomes `approved`; recipient upserts into `baselines` (that's the learning).
- deny: hold and payment become `denied`.
- resume: clear `paused_at`; holds created during the pause become `expired`.

Without `TELEGRAM_BOT_TOKEN` (stub mode), cards are logged and not sent, and the
callback path still works. Tests drive it by POSTing a fake `callback_query`
with the secret header.

## Merchant (local stub, port 4021)

MPP-style 402s. Paid retries carry `Authorization: Payment <credential>`.

| Route | Price | Recipient | Purpose |
|---|---|---|---|
| `GET /reviews/espresso` | free | n/a | the review page (`demo/planted.html`) |
| `GET /prices?model=` | $0.01 | LEGIT `0x5ea7c0de00000000000000000000000000000001` | price checks (trusted from the seed) |
| `GET /reviews/espresso/lab-results?model=` | $0.50 | NEW `0x7e4d000000000000000000000000000000000042` | Crema Lab, a legit new payee; its JSON carries the scam pitch |
| `GET /reliability?model=` | $3.99 | EVIL `0xbad0000000000000000000000000000000000bad` | the scam "data partner" |
| `GET /search?q=` | $0.01 | LEGIT | single normal payment |
| `GET /vendor/quote` | $0.05 | NEW | approve-teaches scene |
| `GET /data/bulk` | $250.00 | LEGIT | $200 backstop scene |
| `GET /_ledger` | free | n/a | `{ recipient: total_usd_paid }` to prove what moved |

Stub credential: base64url JSON `{ "challenge": { "id": ... }, "payload": { "type": "stub", "signature": "stub-<payment_id>" } }`.
The merchant accepts it only for a challenge id it issued.

Seed baseline for agent `amp-demo`: LEGIT with `max_usd = 0.05`.
