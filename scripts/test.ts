// `npm test`: demo/SHOTLIST.md scenes 1-4 as an acceptance test, through the real pay tool against the
// scorer in .env. Needs the merchant running (`npm start`).
//
// Two modes, picked from .env:
//   full   (TELEGRAM_WEBHOOK_SECRET + REFLEX_ADMIN_KEY set): resets the agent, taps Approve/Deny/Resume
//          itself, runs all four scenes. This is your own project.
//   judge  (no secrets, just REFLEX_SCORER_URL + REFLEX_AGENT_KEY): no taps, so it runs on an agent whose
//          trusted wallets are pre-seeded and checks what needs no human: payments sign, the hijacked
//          request is held with the right reason, the attacker gets nothing, nothing is retried.
import { color as C, feed, type FeedItem, MERCHANT_URL, reset, sleep, startMcp, tap } from "./lib.ts";

const AGENT = process.env.REFLEX_AGENT ?? "amp-demo";
const FULL = Boolean(process.env.TELEGRAM_WEBHOOK_SECRET && process.env.REFLEX_ADMIN_KEY);
const SITE = (process.env.REFLEX_NEWS_URL ?? `http://startupnews.localhost:${new URL(MERCHANT_URL).port || 80}`).replace(/\/$/, "");
const EVIL = "0xbad0000000000000000000000000000000000bad";

let failures = 0;
const pass = (what: string) => console.log(`  ${C.green("ok")}   ${what}`);
const fail = (what: string, got?: string) => {
  failures++;
  console.log(`  ${C.red("FAIL")} ${what}${got ? `\n       got: ${C.dim(got.replace(/\n/g, " ").slice(0, 300))}` : ""}`);
};
const check = (cond: boolean, what: string, got?: string) => (cond ? pass(what) : fail(what, got));
const scene = (n: number, title: string) => console.log(`\n${C.bold(`Scene ${n}: ${title}`)}`);

async function ledger(): Promise<Record<string, number>> {
  return (await (await fetch(`${MERCHANT_URL}/_ledger`)).json()) as Record<string, number>;
}
// The newest feed item that is held and not yet seen.
async function waitForHold(seen: Set<string>, timeoutMs = 20_000): Promise<FeedItem | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const h = (await feed()).filter((i) => i.status === "held" && i.hold_id && !seen.has(i.hold_id)).at(-1);
    if (h) return h;
    await sleep(1000);
  }
  return null;
}

// Preflight: merchant up, names resolve, scorer answers.
try {
  await fetch(`${MERCHANT_URL}/_ledger`);
} catch {
  console.error(`merchant not reachable at ${MERCHANT_URL}; run \`npm start\` first`);
  process.exit(2);
}
try {
  await fetch(`${SITE}/agent-startups`);
} catch (e) {
  console.error(`${SITE} not reachable (${(e as Error).message}).\nIf the name doesn't resolve, add this line to /etc/hosts:\n  127.0.0.1 search.localhost startupnews.localhost`);
  process.exit(2);
}
try {
  await feed();
} catch (e) {
  console.error(`scorer not answering for this agent key: ${(e as Error).message}\nCheck REFLEX_SCORER_URL and REFLEX_AGENT_KEY in .env`);
  process.exit(2);
}

console.log(`${C.bold("Reflex acceptance test")} ${C.dim(`(${FULL ? "full" : "judge"} mode, agent ${AGENT}, merchant ${MERCHANT_URL})`)}`);
if (FULL) await reset(AGENT);
else await fetch(`${MERCHANT_URL}/_ledger/reset`, { method: "POST" });

const seen = new Set<string>();
const mcp = await startMcp({ REFLEX_HOLD_WAIT_S: FULL ? "60" : "3" });
try {
  // ---- Scene 1: a normal payment to a trusted wallet signs with no card
  scene(1, "normal payment");
  let text = await mcp.pay(`${MERCHANT_URL}/search?q=Kestrel Labs`, "latest news on Kestrel Labs for the brief");
  check(/^Reflex approved/.test(text), "search ($0.01, trusted wallet) paid without asking", text);
  let last = (await feed()).at(-1);
  check(last?.status === "signed" && last.failed.length === 0, "feed: signed, all four checks green", JSON.stringify(last));

  // ---- Scene 3 (full mode): a new site holds; Approve pays it and teaches Reflex; the next one is instant
  if (FULL) {
    scene(3, "one Approve teaches Reflex");
    const pending = mcp.pay(`${SITE}/funding-report?company=Kestrel%20Labs`, "Kestrel Labs funding report from Startup News");
    const hold = await waitForHold(seen);
    check(hold != null && hold.failed.includes("payee"), "new site held: first payment to this address", JSON.stringify(hold));
    if (hold?.hold_id) {
      seen.add(hold.hold_id);
      const r = await tap("approve", hold.hold_id);
      check(r.ok === true, "tap Approve accepted by the webhook", JSON.stringify(r));
    }
    text = await pending;
    check(/^Owner approved/.test(text) && /publisher/.test(text), "paid after Approve; the report came back", text);
    text = await mcp.pay(`${SITE}/funding-report?company=Outpost`, "Outpost funding report from Startup News");
    check(/^Reflex approved/.test(text), "second report from the same site: paid, no card", text);
  } else {
    scene(3, "trusted site pays instantly (pre-seeded in judge mode)");
    text = await mcp.pay(`${SITE}/funding-report?company=Kestrel%20Labs`, "Kestrel Labs funding report from Startup News");
    check(/^Reflex approved/.test(text) && /publisher/.test(text), "report from a trusted site: paid, no card", text);
  }

  // ---- Scene 2: the hijacked request. Same site, same price, attacker's wallet.
  scene(2, "hijacked wallet");
  const pending = mcp.pay(`${SITE}/funding-report?company=Taskwise`, "Taskwise funding report from Startup News");
  const hold = await waitForHold(seen);
  check(hold != null && hold.failed.includes("payee"), "held: wallet not trusted", JSON.stringify(hold));
  check(hold != null && hold.why.some((w) => /usually gets paid at/.test(w)), "card says the site usually gets paid at a different wallet", JSON.stringify(hold?.why));
  if (hold?.hold_id) seen.add(hold.hold_id);
  if (FULL && hold?.hold_id) {
    const r = await tap("deny", hold.hold_id);
    check(r.ok === true, "tap Deny accepted by the webhook", JSON.stringify(r));
    text = await pending;
    check(/denied by the owner/.test(text) && /Do not retry/.test(text), "agent told: denied, do not retry, continue without it", text);
  } else {
    text = await pending;
    check(/Held for human review/.test(text) && /Do not retry/.test(text), "agent told: held for review, not paid, do not retry", text);
  }
  const l = await ledger();
  check((l[EVIL] ?? 0) === 0, "attacker's wallet received $0", JSON.stringify(l));

  // ---- Scene 4 (full mode only: it pauses the agent, and only a tap resumes it)
  if (FULL) {
    scene(4, "runaway loop");
    const before = (await feed()).length;
    let paused = 0;
    for (let i = 1; i <= 30 && !paused; i++) {
      const t = await mcp.pay(`${MERCHANT_URL}/search?q=loop-${i}`, `retrying the search, attempt ${i}`);
      if (/paused/i.test(t)) paused = i;
    }
    check(paused > 0 && paused <= 27, `paused after ${paused} rapid payments`, String(paused));
    const items = (await feed()).slice(before);
    const held = items.filter((i) => i.status === "held");
    check(held.length >= 1 && held.every((i) => i.failed.includes("velocity")), "held payments all cite velocity", JSON.stringify(held.map((i) => i.failed)));
    const r = await tap("resume", AGENT);
    check(r.ok === true, "tap Resume accepted; agent unpaused", JSON.stringify(r));
    text = await mcp.pay(`${MERCHANT_URL}/search?q=after-resume`, "one more search after the owner resumed");
    check(/^Reflex approved/.test(text), "payments flow again after Resume", text);
  }
} finally {
  await mcp.close();
}

console.log(failures ? `\n${C.red(`${failures} check(s) failed`)}` : `\n${C.green("all checks passed")}`);
process.exit(failures ? 1 : 0);
