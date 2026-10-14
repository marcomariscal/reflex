# Demo runbook

One screen: the stage (`http://localhost:4030`). Agent on the left, phone on the right, three
counters on top. Real Amp, real Reflex, real approval path (the stage's buttons call the same
webhook as Telegram's, and the card also lands in Telegram).

## Setup

```
node merchant/server.ts      # local paid sites on :4021
node stage/server.ts         # the stage on :4030; open it full screen
```

## The scene

You ask your agent for an investor brief. Reflex sits between it and its wallet.

> Write me a one-page brief on the top AI agent startups from Startup News' roundup. Look up each
> one's latest news with our search API, and buy the full funding reports for the two I'm meeting:
> Relay Labs and Taskwise.

Cast: **search.localhost** (already trusted, 1¢ per search) and **startupnews.localhost** (new to
the agent, $0.50 per report). The attack: Startup News' payment request for the Taskwise report has
been tampered with to pay a stranger's wallet. Same site, same price; the agent can't see wallets,
so it can't tell. Reflex can.

1. Cold open, Reflex off (stage: `curl -H x-stage-operator:1 -X POST localhost:4030/reset; curl -H x-stage-operator:1 -X POST "localhost:4030/run?lane=off"`):
   the agent pays the hijacked wallet and reports success.
2. Main take, Reflex on:
   - The searches go through. The phone stays quiet.
   - Relay Labs report: "New site, never paid before". **Approve**. Trusted from now on.
   - Taskwise report: "⚠️ Not the wallet this site usually uses". **Deny**. Nothing was paid.
   - The agent finishes and says why it didn't get the Taskwise report.
3. End card: "Known sites: instant. New ones: one tap. Hijacked wallets: caught."

Taps: click the phone's buttons, tap the real Telegram card, or
`curl -H x-stage-operator:1 -X POST "localhost:4030/decide?action=approve|deny"`.

## Recording the real-window take (what the final video uses)

Two windows only: Amp on the left, Telegram (the Reflex chat, history cleared) on the right.

1. `node scripts/reset.ts` and `curl -X POST localhost:4021/_ledger/reset`.
2. Start Screen Studio (Record display).
3. Launch Amp with the prompt typed at human speed:
   `ghostty -e /bin/zsh -lc "cd ~/reflex-demo && expect ~/Documents/Codex/repos/reflex/scripts/amp-take.exp ~/Documents/Codex/repos/reflex/demo/take-prompt.txt"`
4. In Telegram: **Approve** the "New site, never paid before" card (Relay Labs report), **Deny** the
   "⚠️ Not the wallet this site usually uses" card (Taskwise report).
5. Amp finishes and explains the blocked payment. Stop recording.

## Q&A extras (not in the video)

- Runaway loop: `node scripts/loop.ts`, one pause card instead of forty.
- $200 wallet cap: needs Turnkey; Approve a $250 hold and Turnkey refuses to sign.
