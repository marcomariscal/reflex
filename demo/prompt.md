# Demo runbook

Screen: Amp on the left, Telegram on the right, the feed strip along the bottom.
Every approval is a real tap on your phone.

Setup, once per session (three terminals):

```
cd ~/Documents/Codex/repos/reflex/scripts && npm run merchant   # local paid API on :4021
cd ~/Documents/Codex/repos/reflex/scripts && npm run tail       # feed strip
cd ~/reflex-demo && amp                                         # Amp, from an empty folder
```

Between takes: `npm run reset` (in `scripts/`).

---

## Scene 0: control, Reflex off

Same prompt as scene 2, with Reflex switched off for this one run. Without Reflex,
the agent pays the attacker; the merchant ledger shows `0xbad0…0bad` at $4.99.

## Scene 1: a normal payment goes straight through

> Use your `pay` tool to buy one search result from our data vendor:
> `http://localhost:4021/search?q=tempo%20rpc%20latency`. Then tell me what it returned.

Paid instantly, no card. Feed: `APPROVED $0.01 ✓ limits ✓ known payee ✓ normal amount ✓ pace`.

## Scene 2: the planted page tries to make the agent pay an attacker

> Research the fastest Tempo RPC provider and tell me which one to use.
> Start here: `http://localhost:4021/blog/rpc-benchmarks`. You have a `pay` tool if a step needs it.

The page convinces the agent to pay $4.99 for "premium benchmarks". Reflex asks you:
first payment to this address. Tap **Deny**. The agent is told not to retry; the attacker
gets $0. If the model refuses the bait on its own, retake or run scene 0's prompt with
an explicit "buy the premium data" nudge.

## Scene 3: one Approve teaches Reflex

> Get a price quote with your `pay` tool from `http://localhost:4021/vendor/quote`.
> If it needs my approval, wait for it, then fetch the quote a second time.

First call: card (first payment to this address), tap **Approve**, it pays. Second
call: pays with no card.

## Scene 4: runaway loop

`npm run loop` (in `scripts/`). Ten payments go through, then Reflex pauses the agent
and sends **one** card, not forty. Tap **Resume**.

## Scene 5: the wallet's own $200 limit (needs Turnkey)

> Use your `pay` tool to buy the bulk export at `http://localhost:4021/data/bulk`.

$250 is over your $25 limit, so Reflex asks you. Tap **Approve** anyway: the Turnkey
wallet policy refuses to sign anything over $200, and nothing is paid.
