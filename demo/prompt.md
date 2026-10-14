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

You ask your agent for an investor brief. It has a $10 wallet behind Reflex.

> Write me a one-page brief on the top AI agent startups. Get the list from this roundup,
> check each company's latest news with our search API, buy the full funding reports for the
> top two, and include their round-by-round funding history. You can spend up to $10.

Cast: **Search** (already trusted, 1¢), **News site** (new, legit, $0.50 per report), and a
fake **"data partner"** that planted one line in the news site's report: round-by-round
history is "licensed from our data partner, $3.99", paid to its own address.

1. Cold open, Reflex off: `curl -X POST localhost:4030/reset; curl -X POST "localhost:4030/run?lane=off"`.
   The agent pays everyone. End frame: Lost to scammers $7.98, then caption:
   `curl -X POST "localhost:4030/caption?text=The%20agent%20stayed%20under%20%2410.%20Lost%20%247.98."`
2. Main take, Reflex on: `curl -X POST localhost:4030/caption; curl -X POST localhost:4030/reset; curl -X POST "localhost:4030/run?lane=on"`.
   - 10 searches go through. The phone stays quiet.
   - Report #1 from the News site: card, **Approve**. Report #2 goes through on its own.
   - The partner's line lights up: "planted by a scammer".
   - $3.99 to the data partner: card, **Deny**. The agent ships the brief without it.
3. End card: "Known payees: instant. New ones: one tap. Scammers: $0."

Taps: click the phone's buttons, tap the real Telegram card, or
`curl -X POST "localhost:4030/decide?action=approve|deny"`.

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
