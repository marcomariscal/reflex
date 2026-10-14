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

## Q&A extras (not in the video)

- Runaway loop: `node scripts/loop.ts`, one pause card instead of forty.
- $200 wallet cap: needs Turnkey; Approve a $250 hold and Turnkey refuses to sign.
