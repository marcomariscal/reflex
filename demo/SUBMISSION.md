# Submission text

Copy from here into the hackathon form. Everything matches the README; edit both if you change a claim.

**Project name:** Reflex

**Tagline (one line):**
A payment firewall for AI agents: one `pay` tool, four checks, one tap for anything unusual.

**Short description (~100 words):**
Reflex sits between an AI agent and its wallet. The agent never holds a key; it can only spend by
calling one MCP tool, `pay`. Every HTTP 402 payment request is scored server-side against the
agent's own history: spending caps, a wallet it has paid before, an amount in line with what you've
approved, and pace. Routine payments sign in milliseconds. Anything unusual holds and sends a
Telegram card: Approve teaches Reflex that wallet, Deny means nothing moves. The agent's stated
reason is shown but never trusted. In the demo, a tampered payment request sends a report purchase
to a stranger's wallet, same site, same price. The agent can't tell. Reflex can.

**The problem:**
Per-request payments (MPP, x402) let agents pay any service with no signup. The first time an
agent can pay, it will pay whoever asks: a swapped recipient address is invisible to the model,
because the model never sees wallets. Spending limits cap the loss but don't prevent it. Asking the
model to spot fraud fails on exactly the attacks that don't show up in the text.

**What's novel:**
- The decision never depends on what the agent says. Reflex judges the money (amount, recipient,
  history, pace), not the story. The agent's reason is displayed to the human and ignored by the scorer.
- Approve is the only thing that raises trust. Auto-signed payments never widen a wallet's limit, so
  a payee can't ratchet its way up 2x per call.
- Payment-redirect detection with no vendor list: "this site usually gets paid at a different wallet"
  comes from the agent's own baseline.
- Fail closed, and the hard cap lives in the wallet (Turnkey policy), outside the scorer.

**How it works:**
`pay` fetches the URL. On a 402 it parses the Machine Payments Protocol challenge and posts it to
the scorer, a Supabase edge function that runs the four checks under a per-agent lock, then either
signs with mppx (exact amount, only to the scored recipient) or holds and sends a Telegram card.
The agent polls the hold; on Approve the scorer signs and the agent retries with the credential.
Decimals come from a stablecoin allowlist, never from the merchant.

**What's built:**
End to end on Tempo testnet: a new wallet held, approved by a real tap, paid on-chain, and the next
payment to that wallet signed with no card. Tx
`0xdb9ad202889f059852f9993918a2702e8426ae732bd0c8ffa4b286734f0cd1c3`. The demo sites run locally
with test money so we control the attacker; the 402 flow, signatures and transfer are real.

**What's not (yet):**
The Turnkey signer is built and probed against Turnkey's API but not in use, so the wallet-enforced
$200 cap isn't live. Next: tiny first payments without a tap, trusted merchant directories,
task-scoped mandates, and more rails (x402) next to MPP.

**Stack:**
TypeScript on Node 24, MCP SDK, Supabase (Postgres + Deno edge functions), mppx (Machine Payments
Protocol), Tempo testnet, viem, Turnkey SDK, Telegram Bot API.

**For judges who want to run it (optional):** clone, `npm start`, and in `.env` set
`REFLEX_AGENT_KEY` to the judge key from the form. Then `npm test` runs the scenes against our hosted
scorer with no further setup: the searches and the first report pay instantly, the hijacked request
is held with "usually gets paid at a different wallet", the attacker's ledger stays at $0. (The judge
agent has Startup News pre-trusted, since you can't tap Approve on our phone.)

**Links:**
- Repo: https://github.com/marcomariscal/reflex
- Demo video: _link goes here_
- Testnet tx: `0xdb9ad202889f059852f9993918a2702e8426ae732bd0c8ffa4b286734f0cd1c3`
