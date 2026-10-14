// reflex-telegram: Telegram webhook for the hold and pause cards' buttons.
// Callback data: approve:<hold_id> | deny:<hold_id> | resume:<agent_id> | keep:<agent_id>
import { connect, type Sql } from "../_shared/db.ts";
import { background, json, safeEq, UUID } from "../_shared/http.ts";
import { answerCallback, closeCard, short } from "../_shared/telegram.ts";

const SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
// Unset (stub mode): any callback carrying the secret header counts, so tests can drive it.
const CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID");

type Decision = { ok: true; result: string; verb: string; rest: string } | { ok: false; error: string };

Deno.serve(async (req) => {
  if (req.method !== "POST" || !safeEq(req.headers.get("x-telegram-bot-api-secret-token") ?? "", SECRET)) {
    return json({ error: "unauthorized" }, 401);
  }
  const update = await req.json().catch(() => null);
  const q = update?.callback_query;
  if (!q) {
    // Logged so the owner can find their chat id when setting TELEGRAM_CHAT_ID.
    if (update?.message?.chat?.id) console.log(`telegram message from chat ${update.message.chat.id}`);
    return json({ ok: true, ignored: "not a callback" });
  }
  const chat = q.message?.chat?.id;
  if (CHAT_ID && String(chat) !== CHAT_ID) {
    console.warn(`ignored callback from chat ${chat}`);
    return json({ ok: true, ignored: "chat not allowed" });
  }

  const [action, id = ""] = String(q.data ?? "").split(":");
  const from = q.from ?? {};
  const who = from.username ? `@${from.username}` : (from.first_name ?? String(from.id ?? "unknown"));
  const sql = connect();
  try {
    const d = await decide(sql, action, id, `telegram:${from.username ?? from.id ?? "unknown"}`);
    if (q.id) await answerCallback(q.id, d.ok ? d.verb : d.error);
    if (d.ok && q.message?.message_id && q.message?.text) {
      await closeCard(chat, q.message.message_id, q.message.text, q.message.entities ?? [], d.verb, `by ${who}. ${d.rest}`);
    }
    return json(d.ok ? { ok: true, result: d.result } : d);
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: "internal error" }, 500);
  } finally {
    background(sql.end({ timeout: 5 }));
  }
});

function decide(sql: Sql, action: string, id: string, by: string): Promise<Decision> {
  if (action === "approve" || action === "deny") return decideHold(sql, action, id, by);
  if (action === "resume" || action === "keep") return decidePause(sql, action, id, by);
  return Promise.resolve({ ok: false, error: "unknown action" });
}

async function decideHold(sql: Sql, action: "approve" | "deny", holdId: string, by: string): Promise<Decision> {
  if (!UUID.test(holdId)) return { ok: false, error: "bad hold id" };
  return await sql.begin(async (tx): Promise<Decision> => {
    const [h] = await tx`
      select h.status, h.payment_id, p.agent_id, p.recipient, p.amount_usd
      from reflex.holds h join reflex.payments p on p.id = h.payment_id
      where h.id = ${holdId}
      for update of h`;
    if (!h) return { ok: false, error: "unknown hold" };
    if (h.status !== "pending") return { ok: false, error: `hold already ${h.status}` };

    const status = action === "approve" ? "approved" : "denied";
    await tx`update reflex.holds set status = ${status}, decided_by = ${by}, decided_at = now() where id = ${holdId}`;
    if (action === "deny") {
      await tx`update reflex.payments set status = 'denied' where id = ${h.payment_id}`;
      return { ok: true, result: status, verb: "Denied", rest: "The agent was told not to retry." };
    }
    // The learning: the payee joins the baseline at this amount. The payment itself signs on the agent's next poll.
    await tx`
      insert into reflex.baselines (agent_id, recipient, max_usd, payment_count, source, last_paid_at)
      values (${h.agent_id}, ${h.recipient}, ${h.amount_usd}::numeric, 1, 'approved', now())
      on conflict (agent_id, recipient) do update
      set max_usd = greatest(baselines.max_usd, excluded.max_usd), payment_count = baselines.payment_count + 1,
        last_paid_at = now()`;
    return { ok: true, result: status, verb: "Approved", rest: `${short(h.recipient)} is now baselined.` };
  });
}

// resume: unpause; payment holds created during the pause expire.
// keep: stay paused; those holds are denied so the agent stops waiting on them.
async function decidePause(sql: Sql, action: "resume" | "keep", agentId: string, by: string): Promise<Decision> {
  return await sql.begin(async (tx): Promise<Decision> => {
    const [a] = await tx`select paused_at from reflex.agents where id = ${agentId} for update`;
    if (!a) return { ok: false, error: "unknown agent" };
    if (!a.paused_at) return { ok: false, error: "agent is not paused" };

    const resume = action === "resume";
    const status = resume ? "expired" : "denied";
    const error = resume ? "held while the agent was paused; expired on resume" : "held while the agent was paused; owner kept it paused";
    const held = await tx`
      with h as (
        update reflex.holds set status = ${status}, error = ${error}, decided_by = ${by}, decided_at = now()
        where agent_id = ${agentId} and kind = 'payment' and status = 'pending'
          and created_at >= (select paused_at from reflex.agents where id = ${agentId})
        returning payment_id
      )
      update reflex.payments set status = ${status} where id in (select payment_id from h) returning id`;
    await tx`
      update reflex.holds set status = ${resume ? "approved" : "denied"}, decided_by = ${by}, decided_at = now()
      where agent_id = ${agentId} and kind = 'pause' and status = 'pending'`;
    if (resume) await tx`update reflex.agents set paused_at = null, resumed_at = now() where id = ${agentId}`;
    return resume
      ? { ok: true, result: "resumed", verb: "Resumed", rest: `${held.length} held payments expired.` }
      : { ok: true, result: "kept paused", verb: "Kept paused", rest: `${held.length} held payments denied.` };
  });
}
