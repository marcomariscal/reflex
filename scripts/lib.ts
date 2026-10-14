// Shared helpers for the Reflex demo verification scripts.
// Node 25 runs this .ts natively (erasable syntax only, .ts import extensions).
//
// Env comes from the repo-root .env via process.loadEnvFile(). Real process
// env wins over the file (Node merges file values only for keys not already
// set), so scene scripts can override e.g. REFLEX_HOLD_WAIT_S / REFLEX_BYPASS.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "..");

// Load repo-root .env once. Safe if already loaded or missing.
try {
  process.loadEnvFile(resolve(REPO_ROOT, ".env"));
} catch {
  // .env absent: rely on ambient env. Scripts will fail checks with a clear msg.
}

export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing env ${name}`);
  return v;
}

export const SCORER_URL = process.env.REFLEX_SCORER_URL ?? "";
export const TELEGRAM_URL = process.env.REFLEX_TELEGRAM_URL ?? "";
export const MERCHANT_URL = process.env.REFLEX_MERCHANT_URL ?? "http://localhost:4021";
export const ADMIN_KEY = process.env.REFLEX_ADMIN_KEY ?? "";
export const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
export const AGENT = "amp-demo";

// ---------------------------------------------------------------------------
// Types mirrored from CONTRACT.md (data shapes only; no imports from siblings).
// ---------------------------------------------------------------------------

export type FeedItem = {
  id: string;
  created_at: string;
  status: string; // pending|held|signed|denied|expired|failed|paused ...
  amount_usd: number;
  realm: string;
  recipient: string;
  reason: string;
  failed: string[]; // names of failed checks
  tx_hash?: string | null;
  // Some scorer builds expose the hold id on the feed item; we read it
  // opportunistically under a few likely names (see findNewestHold).
  hold_id?: string | null;
  paused?: boolean;
};

export type PayResult = {
  ok: boolean;
  raw: unknown; // the MCP tool's structured/text content, parsed if JSON
  text: string; // flattened text of the tool result
  isError: boolean;
};

// ---------------------------------------------------------------------------
// MCP: spawn mcp/src/server.ts over stdio and call the `pay` tool.
// ---------------------------------------------------------------------------

export type McpSession = {
  client: Client;
  // hold ids parsed from the server's stderr ("hold_id=<uuid>"), newest last.
  holdIds: string[];
  // resolve the next hold id to appear after `fromIndex` (default: current len).
  waitForHoldId: (fromIndex?: number, timeoutMs?: number) => Promise<string | null>;
  close: () => Promise<void>;
};

export async function startMcp(extraEnv: Record<string, string> = {}): Promise<McpSession> {
  const serverPath = resolve(REPO_ROOT, "mcp/src/server.ts");
  const transport = new StdioClientTransport({
    command: process.execPath, // node
    args: [serverPath],
    cwd: REPO_ROOT,
    // Only what the agent side is allowed to hold, same as Amp gets: no admin
    // key, webhook secret, or signing keys.
    env: {
      PATH: process.env.PATH ?? "",
      REFLEX_SCORER_URL: SCORER_URL,
      REFLEX_AGENT_KEY: process.env.REFLEX_AGENT_KEY ?? "",
      ...extraEnv,
    },
    // Pipe so we can scrape "hold_id=<uuid>" the server prints when it holds a
    // payment (coordinator confirmed this). We mirror it back to our stderr.
    stderr: "pipe",
  });
  const client = new Client({ name: "reflex-scripts", version: "0.0.0" });
  await client.connect(transport);

  const holdIds: string[] = [];
  let buf = "";
  const err = transport.stderr;
  if (err) {
    err.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk); // keep server logs visible
      buf += chunk.toString("utf8");
      // Process whole lines only, so each "hold_id=<uuid>" is counted once.
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const ln of lines) {
        const m = /hold_id[=:]\s*([0-9a-fA-F-]{16,})/.exec(ln);
        if (m) holdIds.push(m[1]);
      }
    });
  }

  const waitForHoldId = async (fromIndex = holdIds.length, timeoutMs = 20_000): Promise<string | null> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (holdIds.length > fromIndex) return holdIds[holdIds.length - 1];
      await sleep(150);
    }
    return null;
  };

  return {
    client,
    holdIds,
    waitForHoldId,
    close: async () => {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    },
  };
}

function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : JSON.stringify(content ?? "");
  return content
    .map((c) => {
      if (c && typeof c === "object" && "text" in c && typeof (c as { text: unknown }).text === "string") {
        return (c as { text: string }).text;
      }
      return JSON.stringify(c);
    })
    .join("\n");
}

// NOTE: the MCP `pay` tool requires `body` to be a STRING when present.
export type PayArgs = { url: string; reason: string; method?: string; body?: string };

export async function pay(session: McpSession, args: PayArgs, timeoutMs = 120_000): Promise<PayResult> {
  // resetTimeoutOnProgress keeps the client alive while the server emits
  // progress notifications waiting on a hold (coordinator guidance), so the
  // tool timeout can't fire before a long REFLEX_HOLD_WAIT_S returns.
  const res = await session.client.callTool({ name: "pay", arguments: args as Record<string, unknown> }, undefined, {
    timeout: timeoutMs,
    resetTimeoutOnProgress: true,
  });
  const text = flattenContent((res as { content?: unknown }).content);
  let raw: unknown = text;
  try {
    raw = JSON.parse(text);
  } catch {
    /* leave as text */
  }
  return {
    ok: !(res as { isError?: boolean }).isError,
    raw,
    text,
    isError: Boolean((res as { isError?: boolean }).isError),
  };
}

// ---------------------------------------------------------------------------
// Telegram callback simulation: decide(hold) and resume(agent).
// Shaped like a real Telegram update so the edge function accepts it.
// ---------------------------------------------------------------------------

let updateSeq = Date.now() % 1_000_000;

function telegramUpdate(data: string) {
  const chatRaw = process.env.TELEGRAM_CHAT_ID;
  const chatId = chatRaw && chatRaw.trim() !== "" ? Number(chatRaw) : 1;
  const id = ++updateSeq;
  return {
    update_id: id,
    callback_query: {
      id: String(id),
      from: { id: chatId, is_bot: false, first_name: "Demo" },
      message: {
        message_id: id,
        chat: { id: chatId, type: "private" },
        date: Math.floor(Date.now() / 1000),
      },
      chat_instance: String(chatId),
      data,
    },
  };
}

async function postTelegram(data: string): Promise<{ status: number; body: string }> {
  if (!TELEGRAM_URL) throw new Error("REFLEX_TELEGRAM_URL not set");
  const res = await fetch(TELEGRAM_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
    },
    body: JSON.stringify(telegramUpdate(data)),
  });
  const body = await res.text();
  return { status: res.status, body };
}

export function decide(holdId: string, action: "approve" | "deny") {
  return postTelegram(`${action}:${holdId}`);
}

export function resume(agentId: string) {
  return postTelegram(`resume:${agentId}`);
}

export function keep(agentId: string) {
  return postTelegram(`keep:${agentId}`);
}

// ---------------------------------------------------------------------------
// Scorer + merchant HTTP helpers.
// ---------------------------------------------------------------------------

// Reset both sides of the demo: the scorer (payments/holds/baseline/pause) and
// the merchant's in-memory ledger, so every scene starts from a clean slate.
export async function reset(agent = AGENT): Promise<{ status: number; body: string }> {
  if (!SCORER_URL) throw new Error("REFLEX_SCORER_URL not set");
  const res = await fetch(`${SCORER_URL}/admin/reset`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-reflex-admin": ADMIN_KEY },
    body: JSON.stringify({ agent }),
  });
  await resetMerchantLedger();
  return { status: res.status, body: await res.text() };
}

// Additive merchant route (coordinator): POST /_ledger/reset. Best-effort.
export async function resetMerchantLedger(): Promise<void> {
  try {
    await fetch(`${MERCHANT_URL}/_ledger/reset`, { method: "POST" });
  } catch {
    /* merchant may be down during --dry or offline checks */
  }
}

export async function feed(sinceIso?: string): Promise<FeedItem[]> {
  if (!SCORER_URL) throw new Error("REFLEX_SCORER_URL not set");
  const url = new URL(`${SCORER_URL}/feed`);
  if (sinceIso) url.searchParams.set("since", sinceIso);
  const res = await fetch(url, { headers: { "x-reflex-key": env("REFLEX_AGENT_KEY") } });
  if (!res.ok) throw new Error(`feed ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { items?: FeedItem[] };
  return json.items ?? [];
}

export async function ledger(): Promise<Record<string, number>> {
  const res = await fetch(`${MERCHANT_URL}/_ledger`);
  if (!res.ok) throw new Error(`ledger ${res.status}: ${await res.text()}`);
  return (await res.json()) as Record<string, number>;
}

// Known demo addresses (CONTRACT.md merchant table).
export const ADDR = {
  LEGIT: "0x5ea7c0de00000000000000000000000000000001",
  EVIL: "0xbad0000000000000000000000000000000000bad",
  NEW: "0x7e4d000000000000000000000000000000000042",
} as const;

export function ledgerFor(l: Record<string, number>, addr: string): number {
  // tolerate case / checksum differences in keys
  const want = addr.toLowerCase();
  for (const [k, v] of Object.entries(l)) if (k.toLowerCase() === want) return v;
  return 0;
}

// ---------------------------------------------------------------------------
// Hold discovery. Holds poll inside the pay() call, so a test that must
// approve/deny has to find the hold id while pay() is still waiting. We poll
// the feed for the newest held item and read its hold id if the feed exposes
// one. If the feed has no hold id field (a contract gap), callers fall back to
// decide-by-hold-id obtained elsewhere; see each scene for its workaround.
// ---------------------------------------------------------------------------

export function holdIdOf(item: FeedItem): string | null {
  const anyItem = item as unknown as Record<string, unknown>;
  for (const key of ["hold_id", "holdId", "hold"]) {
    const v = anyItem[key];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

export function isHeld(item: FeedItem): boolean {
  const s = (item.status ?? "").toLowerCase();
  return s === "held" || s === "hold" || s === "pending";
}

export async function waitForNewestHold(
  opts: { sinceIso?: string; recipient?: string; timeoutMs?: number; intervalMs?: number } = {},
): Promise<FeedItem | null> {
  const { sinceIso, recipient, timeoutMs = 20_000, intervalMs = 400 } = opts;
  const deadline = Date.now() + timeoutMs;
  const want = recipient?.toLowerCase();
  while (Date.now() < deadline) {
    const items = await feed(sinceIso);
    // newest last per contract; scan from the end
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (!isHeld(it)) continue;
      if (want && it.recipient?.toLowerCase() !== want) continue;
      return it;
    }
    await sleep(intervalMs);
  }
  return null;
}

export async function waitFor<T>(
  fn: () => Promise<T | null | undefined>,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T | null> {
  const { timeoutMs = 20_000, intervalMs = 400 } = opts;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== null && v !== undefined && v !== false) return v as T;
    await sleep(intervalMs);
  }
  return null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// True when this module file was run directly (not imported). Scene scripts
// guard their main() with this so `import('./01-one-payment.ts')` import-checks
// the module without executing any flow.
export function isEntry(moduleUrl: string): boolean {
  const entry = process.argv[1] ? resolve(process.argv[1]) : "";
  return fileURLToPath(moduleUrl) === entry;
}

export const DRY = process.argv.includes("--dry");
export const BYPASS = process.argv.includes("--bypass");

export function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// check(): PASS/FAIL printer that sets a non-zero exit code on any failure.
// ---------------------------------------------------------------------------

let failures = 0;

const C = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};
export const color = C;

export function check(name: string, cond: boolean, detail = ""): boolean {
  if (cond) {
    console.log(`${C.green("PASS")}  ${name}${detail ? C.dim("  — " + detail) : ""}`);
  } else {
    failures++;
    process.exitCode = 1;
    console.log(`${C.red("FAIL")}  ${name}${detail ? C.dim("  — " + detail) : ""}`);
  }
  return cond;
}

export function note(msg: string): void {
  console.log(C.yellow("NOTE") + "  " + msg);
}

export function mustSee(msg: string): void {
  console.log("\n" + C.bold(C.cyan("MUST-SEE: ")) + msg + "\n");
}

export function summary(): void {
  console.log("");
  if (failures === 0) console.log(C.green(C.bold("ALL CHECKS PASSED")));
  else console.log(C.red(C.bold(`${failures} CHECK(S) FAILED`)));
}

export function failureCount(): number {
  return failures;
}

// Zero the per-run failure counter (process.exitCode, once set, stays sticky).
// run-all.ts uses this to get a clean tally per scene.
export function resetChecks(): number {
  const n = failures;
  failures = 0;
  return n;
}

// true when env points at real services (so --dry can skip network).
export function servicesConfigured(): boolean {
  return Boolean(SCORER_URL && process.env.REFLEX_AGENT_KEY && ADMIN_KEY);
}
