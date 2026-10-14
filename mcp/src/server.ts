// Reflex MCP server (stdio). One tool, `pay`: fetch a URL; if it answers 402 (MPP),
// ask the Reflex scorer whether to sign, then pay or wait for the owner's decision.
// stdout is the MCP channel, so all logging goes to stderr.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  type Challenge,
  amountUsd,
  authorizationValue,
  credentialHeader,
  fmtUsd,
  parseChallenge,
  parseReceipt,
  shortAddr,
  stubCredential,
} from "./mpp.ts";

// Config comes only from the launcher (Amp settings or the test scripts), never from
// the repo .env: the agent gets its own key and nothing that could approve or sign.
const SCORER = (process.env.REFLEX_SCORER_URL ?? "https://zcbflnilhzdwocswluzg.supabase.co/functions/v1/reflex-score").replace(/\/+$/, "");
const AGENT_KEY = process.env.REFLEX_AGENT_KEY ?? "";
const HOLD_WAIT_S = Number(process.env.REFLEX_HOLD_WAIT_S ?? 120);
const BYPASS = process.env.REFLEX_BYPASS === "1";
const POLL_MS = 2000;
const MAX_BODY = 8000;

type Check = { name: string; pass: boolean; detail: string };
type Decision =
  | { decision: "sign"; payment_id: string; checks: Check[]; credential: string }
  | { decision: "hold"; payment_id: string; hold_id: string; checks: Check[]; paused?: boolean };
type Hold = { status: "pending" | "approved" | "denied" | "expired" | "failed"; payment_id: string; credential?: string; error?: string };
type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
type Req = { method: string; body?: string; headers: Record<string, string> };

const log = (msg: string) => process.stderr.write(`[reflex] ${msg}\n`);
const out = (text: string, isError = false): Result => ({ content: [{ type: "text", text }], ...(isError && { isError }) });

async function scorer<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${SCORER}${path}`, {
    method,
    headers: { "x-reflex-key": AGENT_KEY, ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`);
  }
  if (!res.ok) throw Object.assign(new Error(json?.error ?? `HTTP ${res.status}`), { status: res.status });
  return json as T;
}

async function bodyText(res: Response): Promise<string> {
  let t = await res.text();
  if (/text\/html/i.test(res.headers.get("content-type") ?? "")) t = htmlToText(t);
  return t.length > MAX_BODY ? `${t.slice(0, MAX_BODY)}\n… (${t.length - MAX_BODY} more chars)` : t;
}

// Pages come back as the readable text a browser tool would show an agent, not markup.
function htmlToText(html: string): string {
  const entities: Record<string, string> = {
    nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", mdash: "—", ndash: "–", times: "×", middot: "·",
    hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  };
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>|<!--[\s\S]*?-->/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|h[1-6]|li|tr|table|section|article|header|footer)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&([a-z]+|#39);/g, (m, e) => entities[e] ?? m)
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

const failedChecks = (checks: Check[] = []) =>
  checks.filter((c) => !c.pass).map((c) => c.detail || c.name).join("; ");

// Paid retry with the credential, report the outcome to the scorer, return the merchant's body.
async function payAndSettle(url: string, req: Req, c: Challenge, credential: string, headline: string, paymentId: string | null): Promise<Result> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...req,
      headers: { ...req.headers, [credentialHeader(c)]: authorizationValue(credential) },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    if (paymentId) await settle(paymentId, 0);
    return out(`${headline}, but the paid request failed: ${(e as Error).message}. Do not retry.`, true);
  }
  const receiptHeader = res.headers.get("payment-receipt");
  const receipt = parseReceipt(receiptHeader);
  const ref = typeof receipt?.reference === "string" ? receipt.reference : undefined;
  const txHash = receipt?.method === "tempo" && ref && /^0x[0-9a-f]{64}$/i.test(ref) ? ref : undefined;
  if (paymentId) await settle(paymentId, res.status, receiptHeader ?? undefined, txHash);
  const body = await bodyText(res);
  if (!res.ok) {
    log(`merchant rejected paid retry: HTTP ${res.status}`);
    return out(`${headline}, but the merchant rejected the payment (HTTP ${res.status}). Do not retry.\n\n${body}`, true);
  }
  const rcpt = receipt ? `Receipt: ${receipt.method}${txHash ? ` tx ${txHash}` : ref ? ` ${ref}` : ""}` : "No receipt.";
  log(`${headline} -> HTTP ${res.status}. ${rcpt}`);
  return out(`${headline}. ${rcpt}\n\n${body}`);
}

async function settle(paymentId: string, httpStatus: number, receipt?: string, txHash?: string) {
  try {
    await scorer("POST", "/settle", { payment_id: paymentId, http_status: httpStatus, receipt, tx_hash: txHash });
  } catch (e) {
    log(`settle failed for ${paymentId}: ${(e as Error).message}`);
  }
}

type Extra = { signal: AbortSignal; _meta?: { progressToken?: string | number }; sendNotification: (n: any) => Promise<void> };

async function waitForHold(holdId: string, extra: Extra): Promise<Hold | { status: "timeout" } | { status: "error"; error: string }> {
  const deadline = Date.now() + HOLD_WAIT_S * 1000;
  const token = extra._meta?.progressToken;
  while (Date.now() < deadline && !extra.signal.aborted) {
    try {
      const h = await scorer<Hold>("GET", `/holds/${encodeURIComponent(holdId)}`);
      if (h.status !== "pending") return h;
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status && status >= 400 && status < 500) return { status: "error", error: (e as Error).message };
      log(`hold poll error (will retry): ${(e as Error).message}`);
    }
    if (token !== undefined) {
      const waited = Math.round((HOLD_WAIT_S * 1000 - (deadline - Date.now())) / 1000);
      await extra
        .sendNotification({
          method: "notifications/progress",
          params: { progressToken: token, progress: waited, total: HOLD_WAIT_S, message: "Waiting for the owner on Telegram" },
        })
        .catch(() => {});
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return { status: "timeout" };
}

async function pay(args: { url: string; reason: string; method?: "GET" | "POST"; body?: string }, extra: Extra): Promise<Result> {
  const { url, reason, body } = args;
  const method = args.method ?? "GET";
  const req: Req = {
    method,
    body: method === "POST" ? body : undefined,
    headers: method === "POST" && body ? { "content-type": /^\s*[[{]/.test(body) ? "application/json" : "text/plain" } : {},
  };

  let first: Response;
  try {
    first = await fetch(url, { ...req, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    return out(`Couldn't reach ${url}: ${(e as Error).message}`, true);
  }
  if (first.status !== 402) return out(`HTTP ${first.status}, no payment needed.\n\n${await bodyText(first)}`);

  let c: Challenge;
  try {
    c = parseChallenge(first.headers.get("www-authenticate") ?? "");
  } catch (e) {
    return out(`Got HTTP 402 but couldn't read the payment challenge: ${(e as Error).message}. Not paying.`, true);
  }
  const what = `${fmtUsd(amountUsd(c))} to ${shortAddr(c.recipient)}`;

  if (BYPASS) {
    if (c.method !== "stub") {
      log(`BYPASS refused: method=${c.method}`);
      return out(`REFLEX_BYPASS is on, but this is a real "${c.method}" payment. Bypass only works for stub payments. Not paying.`, true);
    }
    log(`BYPASS ${what} ${url}`);
    return payAndSettle(url, req, c, stubCredential(c, `bypass-${randomUUID()}`), `Paid ${what} (bypass: no Reflex check)`, null);
  }

  if (!AGENT_KEY) return out("Reflex isn't configured (REFLEX_AGENT_KEY is missing). Not paying.", true);

  let d: Decision;
  try {
    d = await scorer<Decision>("POST", "/score", { url, method, reason, challenge: c });
  } catch (e) {
    return out(`Reflex couldn't score this payment: ${(e as Error).message}. Not paying.`, true);
  }

  if (d.decision === "sign") {
    if (!d.credential) return out(`Reflex approved ${what} but returned no credential. Not paid.`, true);
    log(`SIGN ${what} payment_id=${d.payment_id}`);
    return payAndSettle(url, req, c, d.credential, `Reflex approved ${what} (all ${d.checks?.length ?? 4} checks passed)`, d.payment_id);
  }
  if (d.decision !== "hold") return out(`Reflex returned an unknown decision. Not paying.`, true);

  const failed = failedChecks(d.checks);
  const held = `Reflex held ${what}${failed ? ` (${failed})` : ""}.`;
  if (d.paused) {
    log(`HOLD (agent paused) ${what} hold_id=${d.hold_id}`);
    return out(`${held}\nReflex has paused payments for this agent (too many in a short time). Held for human review. Do not retry.`, true);
  }
  log(`HOLD ${what} hold_id=${d.hold_id} waiting up to ${HOLD_WAIT_S}s`);
  const h = await waitForHold(d.hold_id, extra);
  log(`hold ${d.hold_id} -> ${h.status}`);
  switch (h.status) {
    case "approved":
      if (h.credential) return payAndSettle(url, req, c, h.credential, `Owner approved ${what}`, h.payment_id ?? d.payment_id);
      return out(`${held}\nApproved, but Reflex returned no credential. Not paid. Do not retry.`, true);
    case "denied":
      return out(`${held}\nPayment denied by the owner. Do not retry or pay for this another way. Continue the task without it.`, true);
    case "failed":
      return out(`${held}\nThe owner approved it, but signing failed: ${h.error ?? "unknown error"}. Not paid. Do not retry.`, true);
    case "error":
      return out(`${held}\nCouldn't check the hold: ${h.error}. Not paid. Do not retry.`, true);
    default: // expired, timeout
      return out(`${held}\nHeld for human review. Not paid. Do not retry.`, true);
  }
}

const server = new McpServer({ name: "reflex", version: "0.1.0" });

server.registerTool(
  "pay",
  {
    title: "Pay for a paid HTTP resource",
    description:
      "Fetch a URL that may require payment (HTTP 402, Machine Payments Protocol). " +
      "If the server asks for payment, Reflex checks it and either pays or holds it for the owner's approval. " +
      "Free URLs are returned without paying.",
    inputSchema: {
      url: z.url().describe("The URL to fetch"),
      reason: z.string().min(8).describe("why this payment is needed for the user's task; shown to the human approver"),
      method: z.enum(["GET", "POST"]).optional().describe("HTTP method (default GET)"),
      body: z.string().optional().describe("Request body for POST"),
    },
  },
  (args, extra) => pay(args, extra as unknown as Extra),
);

await server.connect(new StdioServerTransport());
log(`ready${BYPASS ? " (REFLEX_BYPASS=1: stub payments skip the scorer)" : ""}`);
