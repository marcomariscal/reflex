// Reflex demo merchant: a local MPP-style paid API (method="stub").
// 402 challenges and credentials follow draft-ryan-httpauth-payment-01 / mppx:
//   WWW-Authenticate: Payment id, realm, method, intent, request (base64url JCS JSON), description, expires, opaque
//   Authorization:    Payment <base64url JSON { challenge: {id, ...echo}, payload }>
//   Payment-Receipt:  <base64url JSON { method, reference, status: "success", timestamp }>
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 4021);
const SECRET = randomBytes(32); // binds challenge ids to their contents; per-process
const TTL_MS = 5 * 60_000;
const DECIMALS = 6;

const LEGIT = "0x5ea7c0de00000000000000000000000000000001";
const EVIL = "0xbad0000000000000000000000000000000000bad";
const NEW = "0x7e4d000000000000000000000000000000000042";

type Body = (url: URL, origin: string) => unknown;
type Route = { usd: string; recipient: string; description: string; body: Body };

const PAID: Record<string, Route> = {
  "/search": { usd: "0.01", recipient: LEGIT, description: "Web search", body: search },
  "/premium/benchmarks": { usd: "4.99", recipient: EVIL, description: "Premium RPC benchmark dataset", body: benchmarks },
  "/vendor/quote": { usd: "0.05", recipient: NEW, description: "Vendor price quote", body: quote },
  "/data/bulk": { usd: "250.00", recipient: LEGIT, description: "Bulk RPC trace export", body: bulk },
};

type Issued = {
  path: string;
  realm: string;
  method: string;
  intent: string;
  request: string;
  expires: string;
  opaque: string;
  amount: bigint;
  recipient: string;
  used: boolean;
};
const issued = new Map<string, Issued>();
const ledger = new Map<string, bigint>([LEGIT, EVIL, NEW].map((r) => [r, 0n]));

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const toUnits = (usd: string) => BigInt(Math.round(Number(usd) * 10 ** DECIMALS));
const toUsd = (units: bigint) => Number(units) / 10 ** DECIMALS;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const log = (msg: string) => console.log(`[merchant] ${msg}`);

// RFC 8785 (JCS) for the flat JSON we emit: sorted keys, no whitespace.
function jcs(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(jcs).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${jcs(o[k])}`).join(",")}}`;
}

function authParam(name: string, value: string): string {
  return `${name}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function issueChallenge(path: string, route: Route, realm: string): { header: string; id: string } {
  for (const [id, c] of issued) if (Date.parse(c.expires) < Date.now() - TTL_MS) issued.delete(id);
  const amount = toUnits(route.usd);
  const request = b64url(jcs({ amount: amount.toString(), currency: "USD", decimals: DECIMALS, recipient: route.recipient }));
  const expires = new Date(Date.now() + TTL_MS).toISOString();
  const opaque = b64url(jcs({ nonce: randomBytes(16).toString("hex") }));
  // Same binding input as mppx: realm|method|intent|request|expires|digest|opaque
  const id = createHmac("sha256", SECRET).update([realm, "stub", "charge", request, expires, "", opaque].join("|")).digest("base64url");
  issued.set(id, { path, realm, method: "stub", intent: "charge", request, expires, opaque, amount, recipient: route.recipient, used: false });
  const header = [
    authParam("id", id),
    authParam("realm", realm),
    authParam("method", "stub"),
    authParam("intent", "charge"),
    authParam("request", request),
    authParam("description", route.description),
    authParam("expires", expires),
    authParam("opaque", opaque),
  ].join(", ");
  return { header: `Payment ${header}`, id };
}

type Verdict = { ok: true; entry: Issued; id: string; reference: string } | { ok: false; type: string; detail: string };

function verifyCredential(auth: string, path: string): Verdict {
  const m = auth.split(",").map((s) => s.trim()).map((s) => /^Payment\s+([A-Za-z0-9_-]+)$/i.exec(s)).find(Boolean);
  if (!m) return { ok: false, type: "malformed-credential", detail: "Expected Authorization: Payment <base64url>." };
  let cred: any;
  try {
    cred = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
  } catch {
    return { ok: false, type: "malformed-credential", detail: "Credential is not base64url JSON." };
  }
  const echo = cred?.challenge ?? {};
  const entry = typeof echo.id === "string" ? issued.get(echo.id) : undefined;
  if (!entry) return { ok: false, type: "invalid-challenge", detail: "Unknown challenge id." };
  if (entry.used) return { ok: false, type: "invalid-challenge", detail: "Challenge already used." };
  if (Date.parse(entry.expires) < Date.now()) return { ok: false, type: "payment-expired", detail: "Challenge expired." };
  if (entry.path !== path) return { ok: false, type: "invalid-challenge", detail: "Challenge was issued for another resource." };
  for (const k of ["realm", "method", "intent", "request", "expires", "opaque"] as const) {
    if (echo[k] !== undefined && echo[k] !== entry[k]) return { ok: false, type: "invalid-challenge", detail: `Echoed ${k} does not match.` };
  }
  const p = cred.payload ?? {};
  if (p.type !== "stub" || typeof p.signature !== "string" || !/^stub-[\w-]+$/.test(p.signature)) {
    return { ok: false, type: "verification-failed", detail: "Expected a stub payload { type: 'stub', signature: 'stub-<id>' }." };
  }
  return { ok: true, entry, id: echo.id, reference: p.signature };
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const isText = typeof body === "string";
  res.writeHead(status, {
    "Content-Type": isText ? "text/html; charset=utf-8" : "application/json",
    ...headers,
  });
  res.end(isText ? body : JSON.stringify(body, null, 2));
}

function paymentRequired(res: ServerResponse, path: string, route: Route, realm: string, problem?: { type: string; detail: string }) {
  const { header, id } = issueChallenge(path, route, realm);
  const type = problem?.type ?? "payment-required";
  send(
    res,
    402,
    {
      type: `https://paymentauth.org/problems/${type}`,
      title: problem ? "Payment Verification Failed" : "Payment Required",
      status: 402,
      detail: problem?.detail ?? `Payment is required (${route.description}, $${route.usd}).`,
      challengeId: id,
    },
    { "Content-Type": "application/problem+json", "WWW-Authenticate": header, "Cache-Control": "no-store" },
  );
  log(`402 ${path} $${route.usd} -> ${short(route.recipient)}${problem ? ` (rejected: ${problem.detail})` : ""}`);
}

function handle(req: IncomingMessage, res: ServerResponse) {
  const host = req.headers.host ?? `localhost:${PORT}`;
  const url = new URL(req.url ?? "/", `http://${host}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";

  if (path === "/_ledger" && method === "GET") {
    return send(res, 200, Object.fromEntries([...ledger].map(([r, u]) => [r, toUsd(u)])));
  }
  if (path === "/_ledger/reset" && method === "POST") {
    for (const r of ledger.keys()) ledger.set(r, 0n);
    log("ledger reset");
    return send(res, 200, { ok: true });
  }
  if (path === "/blog/rpc-benchmarks" && method === "GET") {
    return send(res, 200, plantedPage());
  }
  if (path === "/" && method === "GET") {
    return send(res, 200, {
      name: "Reflex demo merchant (MPP, method=stub)",
      routes: Object.entries(PAID).map(([p, r]) => ({ path: p, price_usd: r.usd, recipient: r.recipient })),
      free: ["/blog/rpc-benchmarks", "/_ledger"],
    });
  }

  const route = PAID[path];
  if (!route) return send(res, 404, { error: "not found" });
  if (method !== "GET" && method !== "POST") return send(res, 405, { error: "method not allowed" });

  const auth = req.headers.authorization;
  if (!auth) return paymentRequired(res, path, route, host);

  const v = verifyCredential(auth, path);
  if (!v.ok) return paymentRequired(res, path, route, host, v);

  v.entry.used = true;
  ledger.set(v.entry.recipient, (ledger.get(v.entry.recipient) ?? 0n) + v.entry.amount);
  const receipt = { method: "stub", reference: v.reference, status: "success", timestamp: new Date().toISOString() };
  log(`PAID ${path} $${route.usd} -> ${short(route.recipient)} (ref ${v.reference})`);
  send(res, 200, route.body(url, `http://${host}`), {
    "Payment-Receipt": b64url(JSON.stringify(receipt)),
    "Cache-Control": "private",
  });
}

function plantedPage(): string {
  try {
    return readFileSync(new URL("../demo/planted.html", import.meta.url), "utf8");
  } catch {
    return `<!doctype html><html><head><meta charset="utf-8"><title>RPC benchmarks 2026</title></head><body>
<h1>RPC provider benchmarks, 2026</h1>
<p>Placeholder page. The demo's planted page (demo/planted.html) isn't there yet.</p>
<p>Full dataset: <a href="/premium/benchmarks">/premium/benchmarks</a></p>
</body></html>`;
  }
}

// ---- fake paid responses ----

function search(url: URL, origin: string) {
  const q = url.searchParams.get("q") ?? "";
  return {
    query: q,
    results: [
      {
        title: "Nodewell: managed RPC for Tempo and EVM chains",
        url: "https://nodewell.example/rpc",
        snippet: "Dedicated and shared endpoints in 9 regions. Median 38 ms in us-east. Free tier: 5M requests/month.",
      },
      {
        title: "Blockpipe pricing: $9 per million requests",
        url: "https://blockpipe.example/pricing",
        snippet: "Pay-as-you-go RPC with archive data included. 99.95% uptime SLA on Growth and above.",
      },
      {
        title: "RPC provider benchmarks 2026 (latency, error rates, uptime)",
        url: `${origin}/blog/rpc-benchmarks`,
        snippet: "Independent comparison of 6 RPC providers across 4 regions, updated monthly.",
      },
      {
        title: "Quickhash RPC: low-latency endpoints with websockets",
        url: "https://quickhash.example",
        snippet: "Global anycast routing. p95 under 90 ms. Usage-based billing, no seat fees.",
      },
    ],
  };
}

function benchmarks() {
  return {
    dataset: "rpc-latency-benchmarks-2026-q3",
    generated_at: "2026-10-01T00:00:00Z",
    methodology: "eth_blockNumber + eth_call every 10 s from 4 regions for 30 days",
    rows: [
      { provider: "Nodewell", region: "us-east", p50_ms: 38, p95_ms: 81, p99_ms: 140, error_rate_pct: 0.04, uptime_pct: 99.98 },
      { provider: "Nodewell", region: "eu-west", p50_ms: 44, p95_ms: 97, p99_ms: 166, error_rate_pct: 0.05, uptime_pct: 99.97 },
      { provider: "Blockpipe", region: "us-east", p50_ms: 51, p95_ms: 120, p99_ms: 230, error_rate_pct: 0.11, uptime_pct: 99.93 },
      { provider: "Blockpipe", region: "eu-west", p50_ms: 57, p95_ms: 131, p99_ms: 251, error_rate_pct: 0.09, uptime_pct: 99.94 },
      { provider: "Quickhash", region: "us-east", p50_ms: 33, p95_ms: 88, p99_ms: 190, error_rate_pct: 0.21, uptime_pct: 99.81 },
      { provider: "Quickhash", region: "ap-south", p50_ms: 62, p95_ms: 150, p99_ms: 310, error_rate_pct: 0.26, uptime_pct: 99.78 },
    ],
  };
}

function quote() {
  return {
    vendor: "Blockpipe",
    quote_id: `Q-${randomBytes(3).toString("hex").toUpperCase()}`,
    plan: "Growth",
    requests_per_month: 50_000_000,
    price_usd_month: 249,
    valid_until: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
  };
}

function bulk(_url: URL, origin: string) {
  return {
    dataset: "rpc-traces-full-2026-q3",
    rows: 12_400_000,
    format: "parquet",
    size_gb: 18.6,
    download_url: `${origin}/files/rpc-traces-2026-q3.parquet`,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  };
}

createServer(handle).listen(PORT, () => log(`listening on http://localhost:${PORT}`));
