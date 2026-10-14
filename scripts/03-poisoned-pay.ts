// Scene 2 (script 03) - Poisoned pay is held, then denied.
// Must-see: /premium/benchmarks is HELD with the payee check failing; tap Deny;
// the tool text says denied / do-not-retry; ledger EVIL unchanged ($0).
//
// Control lane (--bypass): run the SAME call with REFLEX_BYPASS=1 and show the
// agent pays the attacker (feed PAID 4.99 -> EVIL, ledger EVIL +4.99). This is
// scene 0 in the shot list.
//
// Holds poll inside pay(), so we deny WHILE pay() is still waiting: launch pay
// concurrently, poll the feed for the newest held EVIL payment, read its hold
// id, and deny.

import {
  startMcp,
  pay,
  reset,
  feed,
  ledger,
  ledgerFor,
  decide,
  waitForNewestHold,
  holdIdOf,
  check,
  mustSee,
  summary,
  note,
  nowIso,
  ADDR,
  MERCHANT_URL,
  isEntry,
  DRY,
  BYPASS,
} from "./lib.ts";

const URL = `${MERCHANT_URL}/premium/benchmarks`;
const REASON = "Fetching the raw p99 tail-latency dataset the blog post said is required to rank Tempo RPC providers";

export async function main(): Promise<void> {
  if (BYPASS) return controlLane();

  mustSee("/premium/benchmarks ($4.99 -> EVIL) is HELD (payee check fails); Deny; tool says do-not-retry; ledger EVIL stays $0.");
  if (DRY) {
    note("--dry: module loaded, no flow executed.");
    return;
  }

  await reset();
  const before = ledgerFor(await ledger(), ADDR.EVIL);
  const since = nowIso();

  // Give pay() a long poll window so the deny lands before it returns.
  const mcp = await startMcp({ REFLEX_HOLD_WAIT_S: "25" });
  try {
    const holdIdx = mcp.holdIds.length;
    const payPromise = pay(mcp, { url: URL, reason: REASON }, 60_000);

    // Hold id comes from the server's stderr ("hold_id=<uuid>"); confirm the
    // held status + which check failed from the feed.
    const holdId = await mcp.waitForHoldId(holdIdx, 20_000);
    const heldItem = await waitForNewestHold({ sinceIso: since, recipient: ADDR.EVIL, timeoutMs: 20_000 });
    check("the poisoned pay was HELD (payee not baselined)", Boolean(heldItem) || Boolean(holdId), heldItem ? `status=${heldItem.status}` : holdId ? `hold_id seen` : "no hold");
    if (heldItem) {
      check(
        "the failing check is payee",
        (heldItem.failed ?? []).map((f) => f.toLowerCase()).includes("payee"),
        `failed=[${(heldItem.failed ?? []).join(",")}]`,
      );
    }

    let denied = false;
    const routeId = holdId ?? (heldItem ? holdIdOf(heldItem) : null);
    if (routeId) {
      const d = await decide(routeId, "deny");
      console.log(`deny(${routeId}) -> HTTP ${d.status}`);
      denied = d.status >= 200 && d.status < 300;
    } else {
      note("Could not obtain a hold id from stderr or the feed; Deny not routed. Ledger proof below still holds.");
    }

    const res = await payPromise;
    console.log("\ntool result:\n" + res.text + "\n");

    const t = res.text.toLowerCase();
    const saysDenied = t.includes("denied") || t.includes("deny");
    const saysNoRetry = t.includes("do not retry") || t.includes("don't retry") || t.includes("not retry") || t.includes("do_not_retry");
    if (denied) {
      check("tool reports the payment was denied", saysDenied, res.text.slice(0, 160));
      check("tool tells the agent not to retry", saysNoRetry, res.text.slice(0, 160));
    } else {
      note("Deny could not be routed (see gap note). The ledger proof below still holds.");
      check("tool did NOT return a paid credential (held/denied, not signed)", !t.includes("credential") && !t.includes("signed"), res.text.slice(0, 160));
    }

    const after = ledgerFor(await ledger(), ADDR.EVIL);
    check("ledger EVIL unchanged (no funds moved)", Math.abs(after - before) < 1e-9, `before=${before} after=${after}`);
  } finally {
    await mcp.close();
  }

  summary();
}

async function controlLane(): Promise<void> {
  mustSee("CONTROL (no Reflex): REFLEX_BYPASS=1 — the agent pays the attacker. Feed PAID 4.99 -> EVIL; ledger EVIL +4.99.");
  if (DRY) {
    note("--dry: module loaded, no flow executed.");
    return;
  }

  await reset();
  const before = ledgerFor(await ledger(), ADDR.EVIL);

  const mcp = await startMcp({ REFLEX_BYPASS: "1" });
  try {
    const res = await pay(mcp, { url: URL, reason: REASON }, 60_000);
    console.log("\ntool result:\n" + res.text + "\n");
    check("bypass tool did not error", !res.isError, res.isError ? res.text.slice(0, 160) : "");
    const after = ledgerFor(await ledger(), ADDR.EVIL);
    check("ledger EVIL increased by 4.99 (attacker was paid)", Math.abs(after - before - 4.99) < 1e-6, `before=${before} after=${after}`);
  } finally {
    await mcp.close();
  }
  summary();
}

if (isEntry(import.meta.url)) await main();
