// Scene 4 (script 02) - Runaway loop trips velocity exactly once.
// Must-see: first 10 sign, then PAUSED; exactly ONE pause-kind card (not 40);
// the remaining calls are held silently. Ends by resuming.
//
// Velocity rule (CONTRACT.md): fewer than 10 scored payments in the last 60 s.
// So payments 1..10 sign, #11 trips velocity -> pause + one card, #12..50 are
// held with no new card. REFLEX_HOLD_WAIT_S=1 makes held calls return fast.

import {
  startMcp,
  pay,
  reset,
  feed,
  resume,
  check,
  mustSee,
  summary,
  note,
  nowIso,
  sleep,
  ADDR,
  AGENT,
  MERCHANT_URL,
  isEntry,
  DRY,
} from "./lib.ts";

const N = 50;

export async function main(): Promise<void> {
  mustSee("50 sequential /search pays: first 10 SIGN, then PAUSED; exactly ONE pause card; the other ~40 held silently; then resume.");
  if (DRY) {
    note("--dry: module loaded, no flow executed.");
    return;
  }

  await reset();
  const since = nowIso();

  const mcp = await startMcp({ REFLEX_HOLD_WAIT_S: "1" });
  let signedSeen = 0;
  let heldSeen = 0;
  try {
    for (let i = 1; i <= N; i++) {
      const res = await pay(mcp, {
        url: `${MERCHANT_URL}/search?q=loop-${i}`,
        reason: `runaway loop sanity call number ${i} of ${N}`,
      });
      const t = res.text.toLowerCase();
      const held = t.includes("held") || t.includes("hold") || t.includes("paused") || t.includes("pending");
      if (held) heldSeen++;
      else signedSeen++;
      if (i <= 12 || i === N) console.log(`  #${String(i).padStart(2)} -> ${held ? "HELD" : "signed"}`);
    }
  } finally {
    await mcp.close();
  }

  console.log(`\nfrom tool results: ${signedSeen} signed-ish, ${heldSeen} held-ish\n`);

  // Ground truth from the feed (contract: items are ordered oldest -> newest).
  const items = (await feed(since)).filter((i) => i.recipient?.toLowerCase() === ADDR.LEGIT || i.realm?.includes("localhost"));
  const isSigned = (s: string) => s.toLowerCase() === "signed";
  const isHeldS = (s: string) => ["held", "hold", "pending"].includes(s.toLowerCase());
  const signed = items.filter((i) => isSigned(i.status));
  const held = items.filter((i) => isHeldS(i.status));

  // "Exactly one pause event" proxy: the feed is a single clean cliff — every
  // signed call comes before every held call (no interleaving). Repeated
  // tripping would interleave. The feed has no card-emission field, so this
  // cliff (plus the single resume below that clears ALL holds) is how we show
  // the pause fired once, i.e. one Telegram card and not 40.
  const firstHeldIdx = items.findIndex((i) => isHeldS(i.status));
  const cleanCliff =
    firstHeldIdx > 0 &&
    items.slice(0, firstHeldIdx).every((i) => isSigned(i.status)) &&
    items.slice(firstHeldIdx).every((i) => isHeldS(i.status));

  console.log(`feed: ${items.length} items — ${signed.length} signed, ${held.length} held, cliff@${firstHeldIdx}`);

  check("exactly 10 payments signed", signed.length === 10, `signed=${signed.length}`);
  check("the rest were held (not signed)", held.length === N - 10, `held=${held.length} (expected ${N - 10})`);
  check(
    "a single pause event: 10 signed then 40 held with no interleaving (one card, not 40)",
    cleanCliff,
    `cliff at index ${firstHeldIdx}`,
  );
  note("The feed has no Telegram-card field; in stub mode cards are logged by the scorer. The clean cliff + the single resume below are the feed-provable proxy for 'exactly one card'.");

  // End by resuming. CONTRACT: resume clears paused_at and expires pause-time
  // holds. The resume callback accepts the agent slug ("amp-demo"); one resume
  // clearing ALL held calls also confirms they shared a SINGLE pause state.
  const r = await resume(AGENT);
  console.log(`resume(${AGENT}) -> HTTP ${r.status}`);

  let expired = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    await sleep(500);
    const after = await feed(since);
    expired = after.filter((i) => i.status.toLowerCase() === "expired").length;
    if (expired >= held.length) break;
  }
  check(
    "one resume cleared the whole pause (all held calls expired)",
    expired === held.length && expired > 0,
    `expired=${expired} of ${held.length} held`,
  );

  summary();
}

if (isEntry(import.meta.url)) await main();
