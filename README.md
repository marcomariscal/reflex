# Reflex

A payment firewall for AI agents. Your agent never holds a key: it can only spend by calling one
tool, `pay`, and every payment goes through Reflex. Normal payments go straight through. Anything
unusual waits for one tap on your phone.

```
agent ──pay(url, reason)──> Reflex ──ok──> wallet signs ──> Tempo (money moves)
                              │
                              └─unusual──> Telegram: [Approve] [Deny]
```

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

When a site you've paid shows up with a different wallet, the card says so: "⚠️ Not the wallet this
site usually uses." That's the classic payment-redirect fraud, and the agent can't see it because it
never sees wallets.

## The demo

You ask your agent (Amp, in Claude Code mode) for an investor brief on two startups. It pays a search
API it already uses (goes through), buys a report from Startup News (new site: you approve once),
then tries to buy the second report from the same site, whose payment request has been tampered with
to pay a stranger's wallet. Same site, same price; the agent can't tell. Reflex holds it, you deny,
nothing is paid, and the agent explains what happened.

Runbook: [demo/prompt.md](demo/prompt.md). The sites are simulated on the laptop (`*.localhost`) and
use test money; the same flow is verified on Tempo testnet (tx
`0xdb9ad202889f059852f9993918a2702e8426ae732bd0c8ffa4b286734f0cd1c3`).

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

Working end to end on Tempo testnet with a throwaway key. Not yet: Turnkey keys and the wallet-side
$200 cap, small-new-payee thresholds, trusted-directory payees, task-scoped mandates.
