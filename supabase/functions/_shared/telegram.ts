import type { Check } from "./types.ts";

// Without TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, cards are logged instead of sent.
const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
const chatId = Deno.env.get("TELEGRAM_CHAT_ID");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
export const usd = (n: number) => `$${n >= 0.01 || n === 0 ? n.toFixed(2) : String(n)}`;

export type Card = { text: string; buttons: [label: string, data: string][] };

type CardPayment = { agent_id: string; amount_usd: number; realm: string; recipient: string; reason: string; checks: Check[] };

function summary(p: CardPayment) {
  const failed = p.checks.filter((c) => !c.pass).map((c) => `• ${c.name}: ${esc(c.detail)}`);
  const reason = p.reason.length > 300 ? `${p.reason.slice(0, 300)}…` : p.reason;
  return [
    `Agent <b>${esc(p.agent_id)}</b> wants to pay <b>${usd(p.amount_usd)}</b>`,
    `to <code>${short(p.recipient)}</code> at ${esc(p.realm)}`,
    ``,
    `Reason: <i>${esc(reason)}</i>`,
    ``,
    `Failed checks:`,
    ...failed,
  ].join("\n");
}

export const paymentCard = (p: CardPayment, holdId: string): Card => ({
  text: `<b>Reflex held a payment</b>\n\n${summary(p)}`,
  buttons: [["Approve", `approve:${holdId}`], ["Deny", `deny:${holdId}`]],
});

export const pauseCard = (p: CardPayment, limit: number, windowS: number): Card => ({
  text: `<b>Reflex paused ${esc(p.agent_id)}</b>\n\n${limit} payments in ${windowS}s hit the velocity limit. ` +
    `Every further payment is held silently until you decide.\n\nLast attempt:\n${summary(p)}`,
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

export async function answerCallback(id: string, text: string) {
  if (!token) return;
  await call("answerCallbackQuery", { callback_query_id: id, text });
}
