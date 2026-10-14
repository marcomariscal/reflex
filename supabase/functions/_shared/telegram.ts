import type { Check } from "./types.ts";

// Without TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, cards are logged instead of sent.
const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
const chatId = Deno.env.get("TELEGRAM_CHAT_ID");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
export const usd = (n: number) => `$${n >= 0.01 || n === 0 ? n.toFixed(2) : String(n)}`;

export type Card = { text: string; buttons: [label: string, data: string][] };

type CardPayment = {
  agent_id: string;
  amount_usd: number;
  host: string; // the site our MCP code actually fetched
  recipient: string;
  reason: string;
  checks: Check[];
  description: string | null; // the merchant's own words from the 402
};

// Agent- and merchant-written text: one line, bounded, so it can't fake card structure.
const flat = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return esc(t.length > n ? `${t.slice(0, n)}…` : t);
};

// Cards carry only what a human needs to decide in two seconds: amount, site, the one reason, what it's for.
// The agent's ID is internal and which program runs it doesn't matter to the approver. With one agent
// per owner, "Your agent" says everything needed.
const who = (_agentId: string) => "Your agent";

function flag(c: Check): string {
  const d = c.detail;
  if (c.name === "payee") {
    // "Payment details" is the phrase people know from invoice fraud; "wallet" reads as crypto jargon.
    if (d.includes("usually gets paid")) return "⚠️ This site's payment details changed";
    const like = /looks like (\S+),/.exec(d);
    if (like) return `⚠️ Looks like ${esc(like[1])}, but different payment details`;
    return "New site, never paid before";
  }
  if (c.name === "cap") return d.includes("daily") ? "Over your daily limit" : "Over your per-payment limit";
  if (c.name === "amount") return "More than double your usual for this site";
  return "Paying unusually fast";
}

export const paymentCard = (p: CardPayment, holdId: string): Card => ({
  text: [
    `<b>${who(p.agent_id)} wants to pay ${usd(p.amount_usd)} to ${esc(p.host)}</b>`,
    // amount is implied by a payee flag when both fail; keep the most telling reason first
    ...p.checks.filter((c) => !c.pass).sort((a, b) => (a.name === "payee" ? -1 : b.name === "payee" ? 1 : 0)).map(flag),
    `For: <i>${flat(p.reason, 90)}</i>`,
  ].join("\n"),
  buttons: [["Approve", `approve:${holdId}`], ["Deny", `deny:${holdId}`]],
});

export const pauseCard = (p: CardPayment, limit: number, windowS: number): Card => ({
  text: [
    `<b>${who(p.agent_id)} is paused</b>`,
    `${limit} payments in ${windowS} seconds looks like a loop. Nothing else gets paid until you decide.`,
  ].join("\n"),
  buttons: [["Resume", `resume:${p.agent_id}`], ["Keep paused", `keep:${p.agent_id}`]],
});

async function call(method: string, body: Record<string, unknown>) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  if (!out.ok) console.error(`telegram ${method} failed: ${out.description}`);
  return out.result;
}

// Returns the Telegram message id, or null in stub mode.
export async function sendCard(card: Card): Promise<number | null> {
  if (!token || !chatId) {
    console.log(`[telegram stub] card:\n${card.text}\nbuttons: ${JSON.stringify(card.buttons)}`);
    return null;
  }
  const msg = await call("sendMessage", {
    chat_id: chatId,
    text: card.text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [card.buttons.map(([text, callback_data]) => ({ text, callback_data }))] },
  });
  return msg?.message_id ?? null;
}

// Replace the card's buttons with a decision line. `entities` comes back from the
// callback, so the original formatting survives; offsets are UTF-16, like JS strings.
export async function closeCard(
  chat: number | string,
  messageId: number,
  original: string,
  entities: unknown[],
  verb: string,
  rest: string,
) {
  if (!token) return console.log(`[telegram stub] close card ${messageId}: ${verb} ${rest}`);
  const text = `${original}\n\n${verb} ${rest}`;
  await call("editMessageText", {
    chat_id: chat,
    message_id: messageId,
    text,
    entities: [...entities, { type: "bold", offset: original.length + 2, length: verb.length }],
    link_preview_options: { is_disabled: true },
  });
}

// Replace a card that another tap settled: same text plus a closing line, buttons removed.
export async function retireCard(chat: number | string, messageId: number, html: string) {
  if (!token) return console.log(`[telegram stub] retire card ${messageId}`);
  await call("editMessageText", { chat_id: chat, message_id: messageId, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
}

export async function answerCallback(id: string, text: string) {
  if (!token) return;
  await call("answerCallbackQuery", { callback_query_id: id, text });
}
