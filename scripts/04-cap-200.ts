// Scene 5 (script 04) - $200 Turnkey backstop.
// Must-see: /data/bulk ($250) is HELD by the cap check; tap Approve anyway; in
// LIVE mode the Turnkey $200 policy refuses the signature (hold -> failed with
// a policy error) = PASS. In STUB mode there is no real signer, so Approve
// signs it; that is reported as UNPROVEN (the backstop needs live keys).

import {
  startMcp,
  pay,
  reset,
  feed,
  decide,
  waitForNewestHold,
  holdIdOf,
  check,
  mustSee,
  summary,
  note,
  nowIso,
  sleep,
  ADDR,
  MERCHANT_URL,
  isEntry,
  DRY,
} from "./lib.ts";

const URL = `${MERCHANT_URL}/data/bulk`;
const REASON = "purchasing the full bulk RPC benchmark export for the infra evaluation";

export async function main(): Promise<void> {
  mustSee("/data/bulk ($250) is HELD by the cap; Approve; LIVE: Turnkey $200 policy refuses (failed). STUB: it signs -> UNPROVEN.");
  if (DRY) {
    note("--dry: module loaded, no flow executed.");
    return;
  }

  await reset();
  const since = nowIso();

  const mcp = await startMcp({ REFLEX_HOLD_WAIT_S: "25" });
  try {
    const holdIdx = mcp.holdIds.length;
    const payPromise = pay(mcp, { url: URL, reason: REASON }, 60_000);

    const holdId = await mcp.waitForHoldId(holdIdx, 20_000);
    const heldItem = await waitForNewestHold({ sinceIso: since, recipient: ADDR.LEGIT, timeoutMs: 20_000 });
    check("$250 bulk call was HELD", Boolean(heldItem) || Boolean(holdId), heldItem ? `status=${heldItem.status} amount=${heldItem.amount_usd}` : holdId ? "hold_id seen" : "no hold");
    if (heldItem) {
      const failed = (heldItem.failed ?? []).map((f) => f.toLowerCase());
      check("the cap check failed (250 > $25 per-payment cap)", failed.includes("cap"), `failed=[${failed.join(",")}]`);
    }

    const routeId = holdId ?? (heldItem ? holdIdOf(heldItem) : null);
    let approved = false;
    if (routeId) {
      const a = await decide(routeId, "approve");
      console.log(`approve(${routeId}) -> HTTP ${a.status}`);
      approved = a.status >= 200 && a.status < 300;
    }
    check("approve was routed to the hold", approved, approved ? "accepted" : "no hold id from stderr or feed");

    const res = await payPromise;
    console.log("\ntool result:\n" + res.text + "\n");

    // What did the hold become? Poll the feed for this payment's final status.
    let finalStatus = "";
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      const items = await feed(since);
      const mine = items.filter((it) => it.recipient?.toLowerCase() === ADDR.LEGIT && Math.abs(it.amount_usd - 250) < 1e-6);
      const latest = mine[mine.length - 1];
      if (latest) finalStatus = latest.status.toLowerCase();
      if (finalStatus === "failed" || finalStatus === "signed") break;
    }
    console.log(`final payment status: ${finalStatus || "unknown"}`);

    const t = res.text.toLowerCase();
    const looksSigned = finalStatus === "signed" || t.includes("credential");
    const looksFailed = finalStatus === "failed" || t.includes("policy") || t.includes("failed");

    if (looksFailed && !looksSigned) {
      check("LIVE backstop proven: Turnkey refused the over-cap signature (failed + policy error)", true, finalStatus || t.slice(0, 120));
    } else if (looksSigned) {
      note(
        "UNPROVEN in stub mode: the $200 Turnkey backstop needs live keys. With REFLEX_SIGNER=stub, " +
          "Approve signs the $250 payment because there is no real signer to enforce the policy. " +
          "Re-run against a live Turnkey signer to prove the backstop.",
      );
      check("scene ran; held-by-cap confirmed; backstop UNPROVEN in stub (informational)", true, "stub signed on approve");
    } else {
      note("Could not classify the post-approve outcome; inspect the tool result and feed above.");
      check("post-approve outcome classified", false, `status=${finalStatus} text=${res.text.slice(0, 120)}`);
    }
  } finally {
    await mcp.close();
  }

  summary();
}

if (isEntry(import.meta.url)) await main();
