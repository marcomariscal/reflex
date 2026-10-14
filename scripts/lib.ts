// Shared bits for the demo drivers: env, the MCP client (launched with exactly what
// Amp gets), the scorer feed, and resetting state between takes.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
try {
  process.loadEnvFile(`${REPO_ROOT}.env`);
} catch {
  process.stderr.write("[reflex] no .env in the repo root (cp .env.example .env); scorer calls will fail until it exists\n");
}
const env = (k: string) => process.env[k] ?? "";
export const MERCHANT_URL = process.env.REFLEX_MERCHANT_URL ?? "http://localhost:4021";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const paint = (code: number) => (s: string) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
export const color = { bold: paint(1), dim: paint(2), red: paint(31), green: paint(32), yellow: paint(33), cyan: paint(36) };

export type FeedItem = {
  id: string;
  created_at: string;
  status: string;
  amount_usd: number;
  realm: string;
  recipient: string;
  reason: string;
  failed: string[]; // names of failed checks
  tx_hash?: string | null;
};

export async function feed(): Promise<FeedItem[]> {
  const res = await fetch(`${env("REFLEX_SCORER_URL")}/feed`, { headers: { "x-reflex-key": env("REFLEX_AGENT_KEY") } });
  if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
  return (await res.json()).items ?? [];
}

// Clean slate for a take: no payments or holds, agent unpaused, trusted addresses back to the seed.
export async function reset(): Promise<void> {
  const res = await fetch(`${env("REFLEX_SCORER_URL")}/admin/reset`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-reflex-admin": env("REFLEX_ADMIN_KEY") },
    body: JSON.stringify({ agent: "amp-demo" }),
  });
  if (!res.ok) throw new Error(`reset HTTP ${res.status}`);
  await fetch(`${MERCHANT_URL}/_ledger/reset`, { method: "POST" }).catch(() => {});
}

// The real pay tool over stdio, with the same env Amp passes: scorer URL and agent key only.
export async function startMcp(extra: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [`${REPO_ROOT}mcp/src/server.ts`],
    env: { PATH: env("PATH"), REFLEX_SCORER_URL: env("REFLEX_SCORER_URL"), REFLEX_AGENT_KEY: env("REFLEX_AGENT_KEY"), ...extra },
    stderr: "ignore",
  });
  const client = new Client({ name: "reflex-demo", version: "0.0.0" });
  await client.connect(transport);
  return {
    async pay(url: string, reason: string): Promise<string> {
      const res = await client.callTool({ name: "pay", arguments: { url, reason } }, undefined, { resetTimeoutOnProgress: true, timeout: 300_000 });
      return (res.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
    },
    close: () => client.close(),
  };
}
