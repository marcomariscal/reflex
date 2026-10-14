// One-time Telegram setup: finds your chat id from the /start you sent the bot,
// writes it to .env, and points the bot's webhook at reflex-telegram.
// Usage: node scripts/setup-telegram.ts   (then push secrets, see README)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
process.loadEnvFile(envPath);
const { TELEGRAM_BOT_TOKEN: token, REFLEX_TELEGRAM_URL: hookUrl, TELEGRAM_WEBHOOK_SECRET: secret } = process.env;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN is empty in .env');

const tg = async (method: string, body: object = {}) => {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  return json.result;
};

const me = await tg('getMe');
console.log(`bot: @${me.username}`);

let chatId = process.env.TELEGRAM_CHAT_ID;
if (!chatId) {
  await tg('deleteWebhook'); // getUpdates only works without a webhook
  let msg;
  for (let i = 0; i < 6 && !msg; i++) {
    if (i === 0) console.log(`waiting for a message to @${me.username}...`);
    const updates = await tg('getUpdates', { timeout: 50, allowed_updates: ['message'] });
    msg = updates.map((u: any) => u.message).filter(Boolean).at(-1);
  }
  if (!msg) throw new Error(`No messages yet. Send /start to @${me.username} and rerun.`);
  chatId = String(msg.chat.id);
  console.log(`chat: ${chatId} (${msg.from.first_name})`);
  const env = readFileSync(envPath, 'utf8').replace(/^TELEGRAM_CHAT_ID=.*$/m, `TELEGRAM_CHAT_ID=${chatId}`);
  writeFileSync(envPath, env, { mode: 0o600 });
}

await tg('setWebhook', { url: hookUrl, secret_token: secret, allowed_updates: ['callback_query'], drop_pending_updates: true });
console.log(`webhook: ${hookUrl}`);

await tg('sendMessage', { chat_id: chatId, text: 'Reflex is connected. Held payments will show up here with Approve / Deny.' });
console.log('sent test message');
