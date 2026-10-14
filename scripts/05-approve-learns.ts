// Scene 3 (script 05) - Approve teaches the baseline.
// Must-see: first /vendor/quote (NEW payee) is HELD; tap Approve -> it signs;
// the recipient is learned; a SECOND /vendor/quote signs with NO hold/card.

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
  ADDR,
  MERCHANT_URL,
  isEntry,
  DRY,
} from "./lib.ts";

const URL = `${MERCHANT_URL}/vendor/quote`;

export async function main(): Promise<void> {
  mustSee("First /vendor/quote (NEW payee) is HELD; Approve -> signs + learns payee; second /vendor/quote SIGNS with no hold.");
  if (DRY) {
    note("--dry: module loaded, no flow executed.");
    return;
  }

  await reset();
  const since = nowIso();

  const mcp = await startMcp({ REFLEX_HOLD_WAIT_S: "25" });
  try {
    // --- First call: expect a hold on the NEW payee, then approve. ---
    const holdIdx = mcp.holdIds.length;
    const firstPromise = pay(mcp, { url: URL, reason: "requesting a vendor price quote for the infra evaluation" }, 60_000);

    const holdId = await mcp.waitForHoldId(holdIdx, 20_000);
    const heldItem = await waitForNewestHold({ sinceIso: since, recipient: ADDR.NEW, timeoutMs: 20_000 });
    check("first /vendor/quote was HELD (new payee)", Boolean(heldItem) || Boolean(holdId), heldItem ? `status=${heldItem.status}` : holdId ? "hold_id seen" : "no hold");
    if (heldItem) {
      check(
        "the failing check is payee",
        (heldItem.failed ?? []).map((f) => f.toLowerCase()).includes("payee"),
        `failed=[${(heldItem.failed ?? []).join(",")}]`,
      );
    }

    const routeId = holdId ?? (heldItem ? holdIdOf(heldItem) : null);
    let approved = false;
    if (routeId) {
      const a = await decide(routeId, "approve");
      console.log(`approve(${routeId}) -> HTTP ${a.status}`);
      approved = a.status >= 200 && a.status < 300;
    }
    check("approve was routed to the hold", approved, approved ? "accepted" : "no hold id from stderr or feed");

    const first = await firstPromise;
    console.log("\nfirst tool result:\n" + first.text + "\n");
    check("first call ends up signed/paid after approve", first.text.toLowerCase().includes("credential") || first.text.toLowerCase().includes("signed") || !first.isError, first.text.slice(0, 140));

    // --- Second call: should sign immediately, no hold. ---
    const second = await pay(mcp, { url: URL, reason: "re-requesting the vendor quote to confirm the number is stable" }, 30_000);
    console.log("second tool result:\n" + second.text + "\n");
    const t2 = second.text.toLowerCase();
    check("second call did NOT get held", !t2.includes("held") && !t2.includes("hold") && !t2.includes("pending"), second.text.slice(0, 140));
    check("second call signed (payee now learned)", !second.isError, second.text.slice(0, 140));

    // Ground truth. A hold that gets approved becomes "signed", so counting
    // "held" at the end is always 0; instead assert on the stderr hold ids
    // (the server prints one per hold): exactly ONE hold across both calls.
    const newItems = (await feed(since)).filter((i) => i.recipient?.toLowerCase() === ADDR.NEW);
    const signed = newItems.filter((i) => i.status.toLowerCase() === "signed");
    console.log(`feed NEW payee: ${newItems.length} items, ${signed.length} signed; stderr holds=${mcp.holdIds.length}`);
    check("exactly one hold happened total (first call only; second did not)", mcp.holdIds.length === 1, `holds=${mcp.holdIds.length}`);
    check("the new payee was paid (learning worked: both calls signed)", signed.length >= 2, `signed=${signed.length}`);
  } finally {
    await mcp.close();
  }

  summary();
}

if (isEntry(import.meta.url)) await main();
