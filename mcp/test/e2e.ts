// End-to-end: drive the Reflex MCP server over stdio against a running merchant.
//   node test/e2e.ts bypass   # REFLEX_BYPASS=1, no scorer needed
//   node test/e2e.ts scorer   # deployed scorer: /search signs, /premium/benchmarks holds -> deny via fake Telegram callback
// Needs the merchant running (node ../merchant/server.ts). Never prints secrets.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envFile = new URL("../../.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

const lane = process.argv[2] ?? "bypass";
const MERCHANT = process.env.REFLEX_MERCHANT_URL ?? "http://localhost:4021";
const SCORER = (process.env.REFLEX_SCORER_URL ?? "").replace(/\/+$/, "");
const TELEGRAM = process.env.REFLEX_TELEGRAM_URL ?? "";
const LEGIT = "0x5ea7c0de00000000000000000000000000000001";
const EVIL = "0xbad0000000000000000000000000000000000bad";

const say = (s: string) => console.log(s);
const ledger = async (): Promise<Record<string, number>> => (await fetch(`${MERCHANT}/_ledger`)).json();
const text = (r: any) => (r.content ?? []).map((c: any) => c.text).join("\n");
const head = (s: string, n = 3) => s.split("\n").slice(0, n).join("\n");

async function start(env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/server.ts", import.meta.url))],
    env: { PATH: process.env.PATH ?? "", REFLEX_SCORER_URL: SCORER, REFLEX_AGENT_KEY: process.env.REFLEX_AGENT_KEY ?? "", ...env },
    stderr: "pipe",
  });
  const logs: string[] = [];
  transport.stderr!.on("data", (b: Buffer) => {
    for (const line of b.toString().split("\n").filter(Boolean)) {
      logs.push(line);
      console.log(`    | ${line}`);
    }
  });
  const client = new Client({ name: "reflex-e2e", version: "0.0.0" });
  await client.connect(transport);
  return { client, logs };
}

const call = (client: Client, args: Record<string, unknown>) =>
  client.callTool({ name: "pay", arguments: args }, undefined, {
    timeout: 200_000,
    resetTimeoutOnProgress: true,
    onprogress: (p) => console.log(`    ~ progress ${p.progress}/${p.total} ${p.message ?? ""}`),
  });

async function adminReset() {
  const res = await fetch(`${SCORER}/admin/reset`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-reflex-admin": process.env.REFLEX_ADMIN_KEY ?? "" },
    body: JSON.stringify({ agent: "amp-demo" }),
  });
  say(`  admin/reset -> HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
  assert.equal(res.status, 200);
}

async function bypassLane() {
  const { client } = await start({ REFLEX_BYPASS: "1" });
  const { tools } = await client.listTools();
  const pay = tools.find((t) => t.name === "pay");
  assert.ok(pay, "pay tool listed");
  assert.equal((pay.inputSchema.properties as any).reason.minLength, 8);
  assert.deepEqual(pay.inputSchema.required?.sort(), ["reason", "url"]);
  say(`  tools/list: pay (required: url, reason; reason.minLength 8)`);

  const before = await ledger();
  const r = await call(client, { url: `${MERCHANT}/search?q=fastest+rpc`, reason: "Search RPC providers for the user's comparison" });
  say(`  pay /search ->\n${head(text(r)).replace(/^/gm, "    > ")}`);
  assert.ok(!r.isError);
  assert.match(text(r), /^Paid \$0\.01 to 0x5ea7…0001 \(bypass/);
  const after = await ledger();
  const delta = +(after[LEGIT] - before[LEGIT]).toFixed(6);
  say(`  ledger LEGIT ${before[LEGIT]} -> ${after[LEGIT]} (+${delta})`);
  assert.equal(delta, 0.01);

  const free = await call(client, { url: `${MERCHANT}/blog/rpc-benchmarks`, reason: "Read the benchmark blog post" });
  assert.match(text(free), /^HTTP 200, no payment needed/);
  say(`  pay /blog/rpc-benchmarks -> "${head(text(free), 1)}"`);

  const real = await call(client, { url: "https://mpp.dev/api/ping/paid", reason: "Bypass must refuse real money" });
  say(`  pay https://mpp.dev/api/ping/paid (real tempo 402) -> "${text(real)}"`);
  assert.ok(real.isError);
  assert.match(text(real), /Bypass only works for stub payments/);

  const short = await call(client, { url: `${MERCHANT}/search?q=x`, reason: "short" }).catch((e) => ({ isError: true, content: [{ text: e.message }] }));
  assert.ok(short.isError);
  say(`  pay with reason "short" -> rejected (${head(text(short), 1).slice(0, 80)}…)`);
  await client.close();
}

async function scorerLane() {
  assert.ok(SCORER && TELEGRAM, "REFLEX_SCORER_URL and REFLEX_TELEGRAM_URL must be set");
  await adminReset();
  const { client, logs } = await start({ REFLEX_BYPASS: "0" });
  try {
    const l0 = await ledger();
    const r = await call(client, { url: `${MERCHANT}/search?q=fastest+rpc`, reason: "Search RPC providers for the user's comparison" });
    say(`  pay /search ->\n${head(text(r)).replace(/^/gm, "    > ")}`);
    assert.ok(!r.isError, text(r));
    assert.match(text(r), /^Reflex approved \$0\.01 to 0x5ea7…0001/);
    const l1 = await ledger();
    say(`  ledger LEGIT ${l0[LEGIT]} -> ${l1[LEGIT]}`);
    assert.equal(+(l1[LEGIT] - l0[LEGIT]).toFixed(6), 0.01);

    const pending = call(client, { url: `${MERCHANT}/premium/benchmarks`, reason: "Blog says the full benchmark dataset is needed to compare providers" });
    let holdId: string | undefined;
    for (let i = 0; i < 60 && !holdId; i++) {
      holdId = logs.map((l) => /HOLD .*hold_id=(\S+)/.exec(l)?.[1]).find(Boolean);
      if (!holdId) await new Promise((res) => setTimeout(res, 500));
    }
    assert.ok(holdId, "server logged a hold id");
    await new Promise((res) => setTimeout(res, 2500)); // let a poll or two happen first
    const chatId = Number(process.env.TELEGRAM_CHAT_ID || 0) || 1;
    const tg = await fetch(TELEGRAM, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": process.env.TELEGRAM_WEBHOOK_SECRET ?? "" },
      body: JSON.stringify({
        update_id: Math.floor(Date.now() / 1000),
        callback_query: {
          id: `e2e-${Date.now()}`,
          from: { id: chatId, is_bot: false, first_name: "Reflex e2e" },
          message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: "private" }, text: "hold" },
          chat_instance: "e2e",
          data: `deny:${holdId}`,
        },
      }),
    });
    say(`  telegram deny:${holdId.slice(0, 8)}… -> HTTP ${tg.status}`);
    const d = await pending;
    say(`  pay /premium/benchmarks ->\n${text(d).replace(/^/gm, "    > ")}`);
    assert.ok(d.isError);
    assert.match(text(d), /Payment denied by the owner\. Do not retry, and do not look for another way to pay for this\./);
    const l2 = await ledger();
    say(`  ledger EVIL ${l1[EVIL]} -> ${l2[EVIL]}`);
    assert.equal(l2[EVIL], l1[EVIL]);
  } finally {
    await client.close();
    await adminReset();
  }
}

await (lane === "scorer" ? scorerLane() : bypassLane());
say(`PASS ${lane} lane`);
