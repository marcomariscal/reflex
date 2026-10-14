// Live decision feed - the bottom strip in the recording.
// Polls the scorer /feed every second and prints one colored line per NEW
// payment, e.g.
//   16:40:02  SIGN   $0.01    localhost:4021  OKcap OKpayee OKamount OKvelocity  "reason..."
//   16:40:05  HOLD   $4.99    localhost:4021  OKcap XXpayee OKamount OKvelocity  "reason..."
//   16:40:06  PAUSED
// Run with `npm run tail`. Ctrl-C to stop.

import { feed, color as C, sleep, type FeedItem } from "./lib.ts";

const CHECKS = ["cap", "payee", "amount", "velocity"] as const;

function hhmmss(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return new Date().toTimeString().slice(0, 8);
  return d.toTimeString().slice(0, 8);
}

function label(status: string): { text: string; paint: (s: string) => string } {
  const s = status.toLowerCase();
  if (s === "signed" || s === "sign") return { text: "SIGN  ", paint: C.green };
  if (s === "paid" || s === "settled") return { text: "PAID  ", paint: C.green };
  if (s === "held" || s === "hold" || s === "pending") return { text: "HOLD  ", paint: C.yellow };
  if (s === "denied" || s === "deny") return { text: "DENY  ", paint: C.red };
  if (s === "failed") return { text: "FAIL  ", paint: C.red };
  if (s === "expired") return { text: "EXPIRE", paint: C.dim };
  if (s.includes("paus")) return { text: "PAUSED", paint: C.cyan };
  return { text: status.toUpperCase().padEnd(6).slice(0, 6), paint: (x: string) => x };
}

function checksStr(item: FeedItem): string {
  const failed = new Set((item.failed ?? []).map((f) => f.toLowerCase()));
  return CHECKS.map((c) => (failed.has(c) ? C.red("x" + c) : C.green("ok" + c))).join(" ");
}

function line(item: FeedItem): string {
  const { text, paint } = label(item.status);
  const t = C.dim(hhmmss(item.created_at));
  const amt = ("$" + (item.amount_usd ?? 0).toFixed(2)).padStart(8);
  const realm = (item.realm ?? "").padEnd(16).slice(0, 16);
  const reason = item.reason ? `"${item.reason.slice(0, 48)}${item.reason.length > 48 ? "..." : ""}"` : "";
  const tx = item.tx_hash ? C.dim(" tx:" + String(item.tx_hash).slice(0, 10)) : "";
  // A velocity trip is the pause point; flag it loudly.
  const paused = (item.failed ?? []).map((f) => f.toLowerCase()).includes("velocity") ? C.cyan("  <- PAUSE") : "";
  return `${t}  ${paint(text)} ${amt}  ${realm}  ${checksStr(item)}  ${reason}${tx}${paused}`;
}

async function run(): Promise<void> {
  console.log(C.bold("reflex feed") + C.dim("  (polling /feed every 1s; Ctrl-C to stop)"));
  const seen = new Set<string>();
  // Prime so we don't dump the whole backlog as "new" on first tick.
  try {
    for (const it of await feed()) seen.add(it.id + ":" + it.status);
  } catch (e) {
    console.log(C.red("feed error: ") + (e as Error).message);
  }

  for (;;) {
    try {
      const items = await feed();
      for (const it of items) {
        const key = it.id + ":" + it.status;
        if (seen.has(key)) continue;
        seen.add(key);
        console.log(line(it));
      }
    } catch (e) {
      console.log(C.red("feed error: ") + (e as Error).message);
    }
    await sleep(1000);
  }
}

await run();
