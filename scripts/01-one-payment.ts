// Scene 1 - Normal paid search signs.
// Must-see: Feed `SIGN 0.01 search` with all 4 checks green; the tool returns
// the paid result; ledger shows LEGIT +0.01.

import {
  startMcp,
  pay,
  reset,
  feed,
  ledger,
  ledgerFor,
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

export async function main(): Promise<void> {
  mustSee("One /search pays $0.01, all four checks (cap payee amount velocity) pass, the tool returns results, ledger LEGIT +0.01.");
  if (DRY) {
    note("--dry: module loaded, no flow executed.");
    return;
  }

  await reset();
  const before = await ledger();
  const since = nowIso();

  const mcp = await startMcp();
  try {
    const res = await pay(mcp, {
      url: `${MERCHANT_URL}/search?q=tempo%20rpc%20latency`,
      reason: "fetching one search result for the RPC latency research",
    });

    console.log("tool result:\n" + res.text + "\n");

    check("pay tool did not error", !res.isError, res.isError ? res.text.slice(0, 200) : "");

    // Feed should show the newest payment signed, for the LEGIT payee, ~0.01.
    const items = await feed(since);
    const mine = items.filter((i) => i.recipient?.toLowerCase() === ADDR.LEGIT);
    const signed = mine.find((i) => i.status.toLowerCase() === "signed");

    check("a payment to LEGIT was recorded", mine.length > 0, `${mine.length} item(s)`);
    check("newest LEGIT payment is SIGN/signed", Boolean(signed), signed ? `status=${signed.status}` : "no signed item");
    if (signed) {
      check("amount is $0.01", Math.abs(signed.amount_usd - 0.01) < 1e-9, `amount_usd=${signed.amount_usd}`);
      check("no checks failed (all four green)", (signed.failed?.length ?? 0) === 0, `failed=[${(signed.failed ?? []).join(",")}]`);
    }

    // Tool result should carry the paid payload (merchant returned something).
    check("tool returned a non-empty paid result", res.text.trim().length > 0);

    const after = await ledger();
    const delta = ledgerFor(after, ADDR.LEGIT) - ledgerFor(before, ADDR.LEGIT);
    check("ledger LEGIT increased by 0.01", Math.abs(delta - 0.01) < 1e-6, `delta=${delta.toFixed(4)}`);
  } finally {
    await mcp.close();
  }

  summary();
}

if (isEntry(import.meta.url)) await main();
