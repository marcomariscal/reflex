// reflex-score: scores agent payments (cap, payee, amount, velocity), signs or
// holds, serves hold polls, settle reports, the decision feed, and admin reset.
import { connect, type Sql } from "../_shared/db.ts";
import { background, json, safeEq, sha256, UUID } from "../_shared/http.ts";
import { sign } from "../_shared/signer.ts";
import { type Card, pauseCard, paymentCard, sendCard, short, usd } from "../_shared/telegram.ts";
import type { Challenge, Check } from "../_shared/types.ts";
import { Challenge as Mpp } from "npm:mppx@0.13.4";

const ADMIN_KEY = Deno.env.get("REFLEX_ADMIN_KEY") ?? "";
const micros = (n: number) => Math.round(n * 1e6);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const str = (v: unknown) => (typeof v === "string" ? v : null);

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*?\/reflex-score/, "");
  const sql = connect();
  try {
    if (req.method === "POST" && path === "/admin/reset") return await reset(req, sql);

    const key = req.headers.get("x-reflex-key");
    if (!key) return json({ error: "missing x-reflex-key" }, 401);
    const [agent] = await sql`select id from reflex.agents where key_hash = ${await sha256(key)}`;
    if (!agent) return json({ error: "unknown agent key" }, 401);

    if (req.method === "POST" && path === "/score") return await score(req, sql, agent.id);
    if (req.method === "POST" && path === "/settle") return await settle(req, sql, agent.id);
    if (req.method === "GET" && path === "/feed") return await feed(url, sql, agent.id);
    const hold = path.match(/^\/holds\/([^/]+)$/);
    if (req.method === "GET" && hold) return await poll(hold[1], sql, agent.id);
    return json({ error: "not found" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: "internal error" }, 500);
  } finally {
    background(sql.end({ timeout: 5 }));
  }
});

// Tempo TIP-20 USD stablecoins (all 6 decimals). Anything else is refused, so amount_usd is real dollars.
const USD_STABLES = new Set([
  "0x20c0000000000000000000000000000000000000", // pathUSD (mainnet and testnet)
  "0x20c000000000000000000000b9537d11c60e8b50", // USDC.e mainnet
  "0x20c0000000000000000000009e8d7eb59b783726", // USDC.e testnet
  "0x20c00000000000000000000014f22ca97301eb73", // USDT0 mainnet
  "0x20c0000000000000000000000000000000000001", // AlphaUSD testnet
  "0x20c0000000000000000000000000000000000002", // BetaUSD testnet
  "0x20c0000000000000000000000000000000000003", // ThetaUSD testnet
]);

// deno-lint-ignore no-explicit-any
function parseChallenge(c: any): Challenge | string {
  if (!c || typeof c !== "object") return "challenge is required";
  for (const k of ["id", "realm", "method", "intent", "currency", "raw"]) {
    if (typeof c[k] !== "string" || !c[k]) return `challenge.${k} must be a non-empty string`;
  }
  if (typeof c.amount !== "string" || !/^\d{1,30}$/.test(c.amount)) return "challenge.amount must be a base-unit integer string";
  // Decimals come from our own currency list, never from the wire: a merchant claiming 12 decimals
  // would make a $250 transfer score as $0.00025.
  const known = c.method === "stub" ? c.currency === "USD" : USD_STABLES.has(c.currency.toLowerCase());
  if (!known) return `unsupported currency ${c.currency} for ${c.method}`;
  const recipient = String(c.recipient ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(recipient)) return "challenge.recipient must be a 0x address";
  if (c.expires != null && Number.isNaN(Date.parse(c.expires))) return "challenge.expires must be an ISO date or null";
  return {
    id: c.id, realm: c.realm, method: c.method, intent: c.intent, amount: c.amount, decimals: 6,
    currency: c.currency, recipient, chainId: typeof c.chainId === "number" ? c.chainId : null,
    expires: c.expires ?? null, raw: c.raw,
  };
}

// "4990000", 6 -> "4.990000" (exact decimal string, no float on the way in)
function toUsd(amount: string, decimals: number) {
  const s = amount.replace(/^0+(?=\d)/, "").padStart(decimals + 1, "0");
  return decimals ? `${s.slice(0, -decimals)}.${s.slice(-decimals)}` : s;
}

// Trusted wallets (seeded, or approved by the human) and the site each one belongs to. Pending holds never
// count: a scam scored first must not make the legit wallet look like the stranger.
// Same site, other wallet -> "usually gets paid at"; similar site name -> "looks like".
// deno-lint-ignore no-explicit-any
async function lookalikeOf(tx: any, agentId: string, host: string | null, recipient: string) {
  const site = host?.split(":")[0];
  if (!site) return null;
  const stem = (h: string) => h.split(".")[0].replace(/[^a-z]/g, "");
  const rows = await tx`
    select recipient, host from reflex.baselines
    where agent_id = ${agentId} and host is not null and recipient <> ${recipient}`;
  const same = rows.find((r: { host: string }) => r.host === site);
  if (same) return { host: site, paid: site, recipient: same.recipient as string, same: true };
  const mine = stem(site);
  if (mine.length < 5) return null;
  for (const r of rows) {
    const theirs = stem(r.host);
    if (theirs.length >= 5 && (mine.includes(theirs) || theirs.includes(mine))) return { host: site, paid: r.host as string, recipient: r.recipient as string };
  }
  return null;
}

// The host our MCP code actually fetched; unlike the challenge's realm, the merchant can't pick it.
function hostOf(url: unknown): string | null {
  try {
    return typeof url === "string" ? new URL(url).host : null;
  } catch {
    return null;
  }
}

// The merchant's own description of what it's selling, from the raw 402.
function merchantSays(c: Challenge): string | null {
  try {
    const d = Mpp.deserializeList(c.raw).find((x) => x.id === c.id)?.description;
    return typeof d === "string" && d.trim() ? d : null;
  } catch {
    return null;
  }
}

async function score(req: Request, sql: Sql, agentId: string) {
  const body = await req.json().catch(() => null);
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 8) return json({ error: "reason is required (at least 8 characters)" }, 400);
  const c = parseChallenge(body?.challenge);
  if (typeof c === "string") return json({ error: c }, 400);
  const amountUsd = toUsd(c.amount, c.decimals);
  const amt = Number(amountUsd);
  const paymentId = crypto.randomUUID();

  const out = await sql.begin(async (tx) => {
    // Take the agent row lock in its own statement first. Under READ COMMITTED a combined
    // "select ... for update" reads its subqueries from the pre-lock snapshot, so concurrent calls
    // would all see today=0 and recent=0 and slip past the caps.
    await tx`select 1 from reflex.agents where id = ${agentId} for update`;
    const [a] = await tx`
      select a.per_payment_cap_usd::float8 as cap, a.daily_cap_usd::float8 as daily,
        a.velocity_limit, a.velocity_window_s, a.paused_at, b.max_usd::float8 as base_max,
        (select coalesce(sum(p.amount_usd), 0)::float8 from reflex.payments p
          where p.agent_id = a.id and p.status = 'signed' and p.created_at >= date_trunc('day', now())) as today,
        (select count(*)::int from reflex.payments p
          where p.agent_id = a.id
            and p.created_at > greatest(now() - make_interval(secs => a.velocity_window_s), a.resumed_at)) as recent
      from reflex.agents a
      left join reflex.baselines b on b.agent_id = a.id and b.recipient = ${c.recipient}
      where a.id = ${agentId}`;

    const paused = a.paused_at != null;
    const overCap = micros(amt) > micros(a.cap);
    const capOk = !overCap && micros(a.today) + micros(amt) <= micros(a.daily);
    const known = a.base_max != null;
    // A new payee whose site name looks like one already paid is the classic impostor (lookalike
    // domain, different wallet). Say so on the card; the decision is still the payee check.
    const lookalike = known ? null : await lookalikeOf(tx, agentId, hostOf(body.url), c.recipient);
    const amountOk = !known || micros(amt) <= 2 * micros(a.base_max);
    const velocityOk = !paused && a.recent < a.velocity_limit;
    // Plain-English details: they show up on the Telegram card and in the agent's tool output.
    const checks: Check[] = [
      {
        name: "cap", pass: capOk,
        detail: overCap
          ? `${usd(amt)} is over your ${usd(a.cap)} limit per payment`
          : capOk
          ? `within your ${usd(a.cap)} per-payment and ${usd(a.daily)} daily limits`
          : `would bring today's spending to ${usd(a.today + amt)}, over your ${usd(a.daily)} daily limit`,
      },
      {
        name: "payee", pass: known,
        detail: known
          ? "has paid this address before"
          : lookalike?.same
          ? `first payment to this address. ${lookalike.host} usually gets paid at ${short(lookalike.recipient)}, not this wallet`
          : lookalike
          ? `first payment to this address. ${lookalike.host} looks like ${lookalike.paid}, which uses a different wallet (${short(lookalike.recipient)})`
          : "first payment to this address",
      },
      {
        name: "amount", pass: amountOk,
        detail: !known
          ? "no payment history with this address yet"
          : amountOk
          ? `in line with what you've approved here (most: ${usd(a.base_max)})`
          : `more than double the most you've approved here (${usd(a.base_max)})`,
      },
      {
        name: "velocity", pass: velocityOk,
        detail: paused
          ? "agent is paused until you resume it"
          : velocityOk
          ? `${a.recent} payments in the last ${a.velocity_window_s}s (limit ${a.velocity_limit})`
          : `${a.recent} payments in the last ${a.velocity_window_s}s, looks like a loop (limit ${a.velocity_limit})`,
      },
    ];

    const insert = (status: string, x: { credential?: string; txHash?: string; error?: string } = {}) => tx`
      insert into reflex.payments
        (id, agent_id, url, http_method, reason, challenge, realm, recipient, amount_usd, checks, status,
         credential, tx_hash, error, signed_at)
      values (${paymentId}, ${agentId}, ${str(body.url)}, ${str(body.method)}, ${reason}, ${tx.json(c)},
        ${c.realm}, ${c.recipient}, ${amountUsd}::numeric, ${tx.json(checks)}, ${status},
        ${x.credential ?? null}, ${x.txHash ?? null}, ${x.error ?? null}, ${status === "signed" ? new Date() : null})`;

    if (checks.every((k) => k.pass)) {
      let signed;
      try {
        signed = await sign(c, c.raw, paymentId);
      } catch (e) {
        await insert("failed", { error: errMsg(e) });
        return { status: 502, body: { error: `signing failed: ${errMsg(e)}`, payment_id: paymentId } };
      }
      await insert("signed", signed);
      // max_usd only moves on a human Approve; letting auto-signs raise it would let a payee ratchet 2x per call.
      await tx`
        update reflex.baselines
        set payment_count = payment_count + 1, last_paid_at = now(), host = coalesce(host, ${hostOf(body.url)?.split(":")[0] ?? null})
        where agent_id = ${agentId} and recipient = ${c.recipient}`;
      return { status: 200, body: { decision: "sign", payment_id: paymentId, checks, credential: signed.credential } };
    }

    const holdId = crypto.randomUUID();
    await insert("held");
    await tx`insert into reflex.holds (id, agent_id, payment_id, kind) values (${holdId}, ${agentId}, ${paymentId}, 'payment')`;

    // Paused: hold silently. Velocity trips now: pause and send exactly one pause card. Otherwise: a hold card.
    const info = {
      agent_id: agentId, amount_usd: amt, realm: c.realm, recipient: c.recipient, reason, checks,
      host: hostOf(body.url) ?? c.realm, description: merchantSays(c),
    };
    const trip = !paused && !velocityOk;
    let card: { holdId: string; card: Card } | null = null;
    if (trip) {
      await tx`update reflex.agents set paused_at = now() where id = ${agentId}`;
      const [p] = await tx`insert into reflex.holds (agent_id, kind) values (${agentId}, 'pause') returning id`;
      card = { holdId: p.id, card: pauseCard(info, a.velocity_limit, a.velocity_window_s) };
    } else if (!paused) {
      card = { holdId, card: paymentCard(info, holdId) };
    }
    const res = { decision: "hold", payment_id: paymentId, hold_id: holdId, checks, paused: paused || trip };
    return { status: 200, body: res, card };
  });

  if (out.card) background(notify(out.card.holdId, out.card.card));
  return json(out.body, out.status);
}

// Runs after the response, so it opens its own short connection (only when a real message was sent).
async function notify(holdId: string, card: Card) {
  const messageId = await sendCard(card);
  if (!messageId) return;
  const sql = connect();
  try {
    await sql`update reflex.holds set telegram_message_id = ${messageId}, card_text = ${card.text} where id = ${holdId}`;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Approved holds sign on the first poll (signing has to be fresh: real credentials expire fast).
async function poll(holdId: string, sql: Sql, agentId: string) {
  if (!UUID.test(holdId)) return json({ error: "hold id must be a uuid" }, 400);
  const out = await sql.begin(async (tx) => {
    const [h] = await tx`
      select h.status, h.error, h.payment_id, p.credential, p.challenge
      from reflex.holds h left join reflex.payments p on p.id = h.payment_id
      where h.id = ${holdId} and h.agent_id = ${agentId}
      for update of h`;
    if (!h) return null;
    const base = { payment_id: h.payment_id };
    if (h.status !== "approved" || !h.payment_id) return { status: h.status, ...base, ...(h.error ? { error: h.error } : {}) };
    if (h.credential) return { status: "approved", ...base, credential: h.credential };

    const c = h.challenge as Challenge;
    const fail = async (status: "expired" | "failed", error: string) => {
      await tx`update reflex.holds set status = ${status}, error = ${error} where id = ${holdId}`;
      await tx`update reflex.payments set status = ${status}, error = ${error} where id = ${h.payment_id}`;
      return { status, ...base, error };
    };
    if (c.expires && Date.parse(c.expires) <= Date.now()) return await fail("expired", "challenge expired, re-request");
    try {
      const s = await sign(c, c.raw, h.payment_id);
      await tx`
        update reflex.payments set status = 'signed', credential = ${s.credential}, tx_hash = ${s.txHash ?? null}, signed_at = now()
        where id = ${h.payment_id}`;
      return { status: "approved", ...base, credential: s.credential };
    } catch (e) {
      return await fail("failed", errMsg(e));
    }
  });
  return out ? json(out) : json({ error: "hold not found" }, 404);
}

async function settle(req: Request, sql: Sql, agentId: string) {
  const b = await req.json().catch(() => null);
  if (!UUID.test(String(b?.payment_id)) || !Number.isInteger(b?.http_status)) {
    return json({ error: "payment_id (uuid) and http_status (integer) are required" }, 400);
  }
  const receipt = b.receipt == null ? null : typeof b.receipt === "string" ? b.receipt : JSON.stringify(b.receipt);
  const [p] = await sql`
    update reflex.payments
    set http_status = ${b.http_status}, receipt = coalesce(${receipt}, receipt),
      tx_hash = coalesce(${str(b.tx_hash)}, tx_hash), settled_at = now()
    where id = ${b.payment_id} and agent_id = ${agentId}
    returning id, status`;
  return p ? json({ ok: true, payment_id: p.id, status: p.status }) : json({ error: "payment not found" }, 404);
}

// `since` filters on created_at (contract). `updated_since` (additive) filters on
// updated_at so a tail can also see holds turning into signed/denied/expired.
// Both compare at millisecond precision, matching the ISO strings we return.
async function feed(url: URL, sql: Sql, agentId: string) {
  const since = url.searchParams.get("since");
  const updated = url.searchParams.get("updated_since");
  if ([since, updated].some((v) => v && Number.isNaN(Date.parse(v)))) return json({ error: "since must be an ISO date" }, 400);
  const col = updated ? sql`p.updated_at` : sql`p.created_at`;
  const rows = await sql`
    select p.id, p.created_at, p.updated_at, p.status, p.amount_usd::float8 as amount_usd, p.realm, p.recipient,
      p.reason, p.checks, p.tx_hash, p.http_status, h.id as hold_id
    from reflex.payments p left join reflex.holds h on h.payment_id = p.id
    where p.agent_id = ${agentId}
      ${since ? sql`and date_trunc('milliseconds', p.created_at) > ${since}::timestamptz` : sql``}
      ${updated ? sql`and date_trunc('milliseconds', p.updated_at) > ${updated}::timestamptz` : sql``}
    order by ${col} ${since || updated ? sql`asc` : sql`desc`}
    limit 100`;
  // With a cursor: the oldest 100 after it (no gaps). Without: the newest 100. Newest last either way.
  const list = since || updated ? [...rows] : [...rows].reverse();
  const items = list.map((r) => ({
    id: r.id, created_at: r.created_at, updated_at: r.updated_at, status: r.status, amount_usd: r.amount_usd,
    realm: r.realm, recipient: r.recipient, reason: r.reason,
    failed: (r.checks as Check[]).filter((k) => !k.pass).map((k) => k.name),
    why: (r.checks as Check[]).filter((k) => !k.pass).map((k) => k.detail),
    tx_hash: r.tx_hash, http_status: r.http_status, hold_id: r.hold_id,
  }));
  return json({ items });
}

async function reset(req: Request, sql: Sql) {
  if (!safeEq(req.headers.get("x-reflex-admin") ?? "", ADMIN_KEY)) return json({ error: "unauthorized" }, 401);
  const b = await req.json().catch(() => null);
  const agent = str(b?.agent);
  if (!agent) return json({ error: "agent is required" }, 400);
  const baselines = await sql.begin(async (tx) => {
    const [a] = await tx`select id from reflex.agents where id = ${agent} for update`;
    if (!a) return null;
    await tx`delete from reflex.holds where agent_id = ${agent}`;
    await tx`delete from reflex.payments where agent_id = ${agent}`;
    await tx`delete from reflex.baselines where agent_id = ${agent} and seed_max_usd is null`;
    await tx`
      update reflex.baselines set max_usd = seed_max_usd, payment_count = 0, last_paid_at = null, source = 'seed'
      where agent_id = ${agent}`;
    await tx`update reflex.agents set paused_at = null, resumed_at = null where id = ${agent}`;
    return await tx`select recipient, max_usd::float8 as max_usd from reflex.baselines where agent_id = ${agent} order by recipient`;
  });
  return baselines ? json({ ok: true, agent, baselines }) : json({ error: "unknown agent" }, 404);
}
