# Reflex

A payment firewall for AI agents. Your agent never holds a key: it can only spend by calling one
tool, `pay`, and every payment goes through Reflex. Normal payments go straight through. Anything
unusual waits for one tap on your phone.

```
agent ──pay(url, reason)──> Reflex ──ok──> wallet signs ──> Tempo (money moves)
                              │
                              └─unusual──> Telegram: [Approve] [Deny]
```

**Demo video (2 min):** _link goes here_ · Built at Paradigm Frontiers, October 2026.

## What it checks

Every payment, in milliseconds, against facts the agent can't fake:

| Check | Signs automatically when |
|---|---|
| Limits | under $25 per payment and $100 per day |
| Payee | you've paid this wallet before, or approved it once |
| Amount | no more than 2x the most you've approved for that wallet |
| Pace | fewer than 25 payments a minute (a burst pauses the agent: one card, not forty) |

Any failure holds the payment and sends a Telegram card. Approve teaches Reflex that wallet.
The agent's stated reason is shown on the card but never used to decide, because a tricked agent
writes convincing reasons.

Four rules, on purpose. They're checked against the agent's own payment history, so there's no
model to fool and no vendor list to maintain. Smarter scoring can be added behind the same `hold`;
the point is that the decision never depends on what the agent says.

When a site you've paid shows up with a different wallet, the card says so: "⚠️ Not the wallet this
site usually uses." That's the classic payment-redirect fraud, and the agent can't see it because it
never sees wallets.

## The demo

You ask your agent (Amp, in Claude Code mode) for an investor brief on three startups. It pays a
search API it already uses (goes through), buys the first report from Startup News (new site: you
approve once), buys the second from the same site (no card: it's trusted now), then tries to buy the
third, whose payment request has been tampered with to pay a stranger's wallet. Same site, same
price; the agent can't tell. Reflex holds it, you deny, nothing is paid, and the agent explains what
happened.

Runbook: [demo/prompt.md](demo/prompt.md). The sites are simulated on the laptop (`*.localhost`) and
use test money; the same flow is verified on Tempo testnet (tx
`0xdb9ad202889f059852f9993918a2702e8426ae732bd0c8ffa4b286734f0cd1c3`).

## Run it

Node 24 or newer (the `.ts` files run as-is, no build step). The Supabase CLI for your own scorer; Docker only for the local variant.

```
npm start
```

That installs the deps on first run and starts the paid sites (`localhost:4021`, plus port 80 for the
`*.localhost` names) and the one-screen demo view (`localhost:4030`).

The sites run with nothing else installed. For the actual firewall you need the scorer and,
to tap on your phone, a Telegram bot. Both take a few minutes.

### Your own scorer (Supabase)

The scorer and the Telegram webhook are two edge functions on a Supabase project. The demo video
uses ours; you need your own project (free tier is fine) because the agent key is per project.

```
cp .env.example .env                                   # then fill it in as you go
openssl rand -hex 32                                   # run three times: REFLEX_AGENT_KEY, REFLEX_ADMIN_KEY, TELEGRAM_WEBHOOK_SECRET
supabase login && supabase link --project-ref <ref>    # your project; put <ref> in .env's REFLEX_* URLs
supabase db push --include-seed                        # schema, deny-all policies, the demo agent
supabase secrets set REFLEX_ADMIN_KEY=... TELEGRAM_WEBHOOK_SECRET=...
supabase functions deploy                              # both functions
```

Then store the agent key's hash on the seeded agent: the two commands at the top of
[supabase/seed.sql](supabase/seed.sql) (`psql` with the connection string from the dashboard, or paste
the `update` into the SQL editor). The key itself stays in `.env` and is the only thing the
agent is given. `SUPABASE_DB_URL` is provided by the runtime; nothing else is needed for the local
sites (`method=stub`). For Tempo testnet payments add `TEMPO_DEV_PRIVATE_KEY` (a funded throwaway key)
to the secrets; for Turnkey, the `TURNKEY_*` secrets from `.env.example`.

Local alternative, no account: `supabase start && supabase db reset` (Docker; runs the migrations and
seed), then `supabase functions serve --env-file .env` serves both functions at
`http://127.0.0.1:54321/functions/v1/`; point the `REFLEX_*` URLs in `.env` there and set the key hash
on the local database (`postgresql://postgres:postgres@127.0.0.1:54322/postgres`). Telegram can't
reach a local webhook, so this runs in stub mode: cards are logged in the serve output and you tap
them from the stage or with `curl` (see the runbook).

### Telegram

1. In Telegram, message `@BotFather`, send `/newbot`, and put the token it gives you in `.env` as
   `TELEGRAM_BOT_TOKEN`.
2. Send `/start` to your new bot (this is how the script learns your chat id).
3. `node scripts/setup-telegram.ts`: finds your chat id and writes it to `.env`, points the bot's
   webhook at `reflex-telegram` with your secret, and sends you a test message.
4. `supabase secrets set TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=...` so the scorer can send cards
   and the webhook only listens to you.

Without a bot token the scorer still works; cards are logged instead of sent.

### The agent

One MCP server, `mcp/src/server.ts`, launched with `REFLEX_SCORER_URL` and `REFLEX_AGENT_KEY` in
its env and nothing else ([mcp/amp-settings.example.json](mcp/amp-settings.example.json) for Amp;
any MCP client works). `npm run loop` drives the tool without an agent, `npm run reset` gives you a
clean slate between takes, and [demo/prompt.md](demo/prompt.md) is the scene.

## How it works

- **`mcp/`** The `pay` MCP tool. Fetches the URL; on HTTP 402 (Machine Payments Protocol) it parses the
  payment request and asks the scorer. On approval it retries with the signed credential. Gets only
  the scorer URL and an agent key, nothing that can approve or sign.
- **`supabase/functions/reflex-score`** The scorer: runs the checks under a per-agent lock, signs with
  mppx (pull mode, exact amount, only to the scored recipient), or holds and sends the card.
  Decimals come from a USD-stablecoin allowlist, never from the merchant.
- **`supabase/functions/reflex-telegram`** The Approve/Deny webhook (secret header, owner's chat only).
- **Signer** Turnkey when configured (built and probed against Turnkey's API), otherwise a throwaway
  testnet key. Turnkey adds hardware key custody and a $200-per-payment cap the wallet itself enforces.
- **`merchant/`** Local MPP sites for the demo. **`stage/`** An optional one-screen demo view.
  **`scripts/`** Demo drivers (loop, reset, feed strip, Telegram setup, the Amp take launcher).

Interfaces are in [CONTRACT.md](CONTRACT.md).

## Questions a skeptical judge will ask

- **"Don't people just use API keys?"** Keys are fine for the three services you set up by hand. Per-request
  payments (MPP, x402) let agents pay any service with no signup. The first time they can, they'll pay
  whoever asks. Reflex is the reflex in between.
- **"Why not just set a spending limit?"** Limits cap the loss; they don't prevent it. The agent in the
  demo stayed well inside any budget and still paid the wrong wallet.
- **"Why not let the model spot scams?"** It does, when it can see them: Claude refused every injected
  upsell we tried. It can't see a swapped wallet. Reflex judges the money, not the story.
- **"So it asks me about every new vendor?"** Once per wallet, forever. Then only when something
  changes: a new wallet, a bigger amount, a burst.
- **"Isn't this centralized?"** Yes, by design: a firewall you run. It fails closed (scorer down means
  no payments), and the hard cap lives in the wallet, outside Reflex.
- **"Are the sites fake?"** Yes, simulated locally so we control the attacker. The 402 flow, the
  signatures and the Tempo transfer are real (testnet tx above).

## Status

Working end to end on Tempo testnet with a throwaway key: hold, real tap, on-chain payment, and the
next payment to that wallet with no card. The Turnkey signer is built and probed against Turnkey's API
but not yet in use, so the wallet-side $200 cap is not live.

## What's next

- **Keys you don't hold.** Turnkey custody with the $200 cap enforced by the wallet policy, so even a
  compromised scorer can't move more than that.
- **Fewer taps.** Tiny first payments to new wallets ($0.01 searches) sign without asking; trusted
  directories of known merchants count as "paid before".
- **Mandates.** A task-scoped budget and payee set granted up front ("$5, these two sites, next hour"),
  so routine work never pings the phone and anything outside the mandate does.
- **More rails.** The checks only look at amount, recipient and history, so x402 and other 402
  flavors slot in next to MPP with a parser and a signer each.
