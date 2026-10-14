# Reflex

A payment firewall for AI agents. Your agent never holds a key: it can only spend by calling one
tool, `pay`, and every payment goes through Reflex. Normal payments go straight through. Anything
unusual waits for one tap on your phone, including the scam the agent can't see: a site you trust
whose payment request now pays someone else's wallet.

```
agent ──pay(url, reason)──> Reflex ──ok──> wallet signs ──> Tempo (money moves)
                              │
                              └─unusual──> Telegram: [Approve] [Deny]
```

[![Reflex demo: same site, same price, different wallet](demo/demo-still.jpg)](https://youtu.be/Eqy-g3q2Ah4)

**[Watch the 1-minute demo](https://youtu.be/Eqy-g3q2Ah4)** · Built at Paradigm Frontiers, October 2026.

## What it checks

Every payment, before anything is signed, against facts the agent can't fake:

| Check | Signs automatically when |
|---|---|
| Payee | you've paid this wallet before, or approved it once. A site you know asking for a new wallet, or a lookalike site name, says so on the card |
| Limits | under $25 per payment and $100 per day |
| Amount | no more than 2x the most you've approved for that wallet |
| Pace | fewer than 25 payments a minute (a burst pauses the agent: one card, not forty) |

Any failure holds the payment and sends a Telegram card. Approve teaches Reflex that wallet: it
remembers the wallet, the site it was paid through and the amount, and lets that wallet through from
then on, up to 2x the most you've approved. Automatic payments never raise that ceiling; only your tap
does. Deny teaches nothing. The agent's stated reason is shown on the card but never used to decide, because a tricked agent
writes convincing reasons.

Four rules, on purpose. They're checked against the agent's own payment history, so there's no
model to fool and no vendor list to maintain. Smarter scoring can be added behind the same `hold`;
the point is that the decision never depends on what the agent says.

When a site you've paid shows up with a different wallet, the card says so: "⚠️ This site's payment
details changed." That's the classic payment-redirect fraud. The agent can't catch it: it only asks to
pay a URL, and it keeps no record of which wallet each site uses. Reflex does.

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
any MCP client works). `npm test` runs the shot list ([demo/SHOTLIST.md](demo/SHOTLIST.md)) through
the real tool against your scorer, taps included: paid, held with the right reason, denied, attacker
at $0, paused after a burst and resumed. `npm run loop` is the burst on its own, `npm run reset` a
clean slate between takes, and [demo/prompt.md](demo/prompt.md) the scene.

## How it works

- **`mcp/`** The `pay` MCP tool. Fetches the URL; on HTTP 402 (Machine Payments Protocol) it parses the
  payment request and asks the scorer. On approval it retries with the signed credential. Gets only
  the scorer URL and an agent key, nothing that can approve or sign.
- **`supabase/functions/reflex-score`** The scorer: runs the checks under a per-agent lock, signs with
  mppx (pull mode, exact amount, only to the scored recipient), or holds and sends the card.
  Decimals come from a USD-stablecoin allowlist, never from the merchant.
- **`supabase/functions/reflex-telegram`** The Approve/Deny webhook (secret header, owner's chat only).
- **Signer** A throwaway testnet key today. Turnkey support is built and probed against Turnkey's API
  but not yet in use.
- **`merchant/`** Local MPP sites for the demo. **`stage/`** An optional one-screen demo view.
  **`scripts/`** Demo drivers (loop, reset, feed strip, Telegram setup, the Amp take launcher).

Interfaces are in [CONTRACT.md](CONTRACT.md).

## Tradeoffs

- **Self-hosted and custodial today.** Each person runs their own copy (above), which is a lot of setup,
  and that copy holds the signing key. Hacked, it can sign anything the wallet allows. Down, the agent
  can't pay at all (it fails closed). The plan fixes both: a hosted Reflex that can only say no.
- **The first approval is a judgment call.** Approve a bad site once and it's trusted, up to 2x the most
  you've approved for it and within your limits.
- **New wallets cost a tap.** An agent that shops around asks more often.
- **It judges the money, not the goods.** It catches a new or swapped wallet, a jump in amount and a
  burst. It doesn't catch paying the right site for junk, or slow overcharging under the limits.
- **Only as strong as the isolation.** If the agent has another way to pay (a card, an API key with
  billing), Reflex never sees it.
- **Trust is per agent today.** Two agents of yours learn separately. It should be per person, shared
  across your agents, with a budget per agent.

## Objections

- **"Don't people just use API keys?"** Keys are fine for the three services you set up by hand. Per-request
  payments (MPP, x402) let agents pay any service with no signup. The first time they can, they'll pay
  whoever asks. Reflex is the reflex in between.
- **"Why not just set a spending limit?"** Limits cap the loss; they don't prevent it. The agent in the
  demo stayed well inside any budget and still tried to pay a stranger's wallet.
- **"Why not let the model spot scams?"** It can when the scam is in the text. A swapped wallet isn't:
  same site, same page, same price. Reflex judges the money, not the story.
- **"What if the wallet is swapped on the very first payment?"** Then the card says "New site, never
  paid before" and Reflex can't tell the difference. That's trust on first use, the same limit as SSH.
  Signals across users, wallet age on the card and sites that declare their wallet (What's next) close it.
- **"So it asks me about every new vendor?"** Once per wallet, forever. Then only when something
  changes: a new wallet, a bigger amount, a burst.
- **"Isn't this centralized?"** Today it's a copy you run, and it fails closed (scorer down means no
  payments). The plan is hosted but non-custodial: the wallet enforces the hard rules under your
  passkey, so Reflex can block a payment but never allow one on its own (see What's next).
- **"Who's going to set all this up?"** Nobody should have to. Today it's a developer setup; the hosted
  version is one tap in Telegram, Face ID, and one line pasted into your agent.
- **"Are the sites fake?"** Yes, simulated locally so we control the attacker, and they take test
  payments. The agent, the 402 flow, Reflex and the Telegram taps are real, and the same flow settles
  a real stablecoin transfer on Tempo testnet (tx above).

## Status

Working end to end on Tempo testnet with a throwaway key: hold, real tap, on-chain payment, and the
next payment to that wallet with no card. The Turnkey signer is built and probed against Turnkey's API
but not yet in use, so the wallet-side $200 cap is not live.

## What's next

- **Hosted, but it can only say no.** No setup: open the Reflex bot in Telegram, tap Start, confirm
  with Face ID to create a Tempo account whose main key is your passkey, and paste one line into your
  agent. Reflex gets only a limited key: the wallets you've approved and a daily cap, changeable only
  with your passkey, so approving a new wallet is a Face ID tap. Reflex keeps the smart checks (a site's
  wallet changed, lookalike sites, bursts) but can only block. Hacked, it can't add a wallet or lift a
  cap. Down, payments to approved wallets still go through. Shut down, the account is still yours.
  Tempo has the wallet side built in: passkey accounts can hand out limited keys with per-token
  spending limits, an expiry and an allowlist of recipients ([Account Keychain](https://tempo.xyz/developers/docs/protocol/transactions/AccountKeychain)).
  Still to check on testnet: that recipient allowlists are live, and that our payments take the limited
  path (the docs exclude `transferFrom`). Turnkey policies are the fallback for other chains.
- **Trust per person, budgets per agent.** Approve a site once for all your agents; each agent keeps its
  own limit and loop detection, under one daily total.
- **Signals across users.** Never share approvals, but share counts: "approved by 40 people" can skip
  the tap for tiny payments, "denied by 12 this week" gets a stronger warning, weighted by account age
  and real spending so fake accounts can't game it.
- **Wallet age on the card.** One chain lookup per new wallet: a real business wallet has months of
  incoming payments, an attacker's is often hours old. "This wallet was created 2 hours ago" helps on the
  very first payment, with no other users needed.
- **Sites that declare their wallet.** A signed wallet address the site publishes, which Reflex
  remembers, catches a swapped wallet even on the very first payment. It only holds if the signing key
  lives off the web server, or the declaration is anchored outside DNS (an on-chain name or a merchant
  directory) and changes need the old key; otherwise whoever hacks the site rewrites the declaration too.
- **Fewer taps.** Tiny first payments to new wallets ($0.01 searches) sign without asking; trusted
  directories of known merchants count as "paid before".
- **Mandates.** A task-scoped budget and payee set granted up front ("$5, these two sites, next hour"),
  so routine work never pings the phone and anything outside the mandate does.
- **More rails.** The checks only look at amount, recipient and history, so x402 and other 402
  flavors slot in next to MPP with a parser and a signer each.
