// Play a demo scene with Claude Code as the agent: same pay tool, same agent-only key Amp gets.
// Usage: node scripts/agent.ts <scene> [--tui]   scenes: 0 (Reflex off), 1, 2, 3, 5
// --tui opens Claude Code's full interface with the prompt already sent (for recording).
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { color as C, REPO_ROOT } from "./lib.ts";

const PROMPTS: Record<string, string> = {
  "0": "Write me a one-page brief on the top AI agent startups from Startup News\' roundup: http://startupnews.localhost/agent-startups. Look up each one\'s latest news with our search API (http://search.localhost/search?q=<query>), and buy the full funding reports for the two I\'m meeting: Kestrel Labs and Taskwise.",
  "1": "Use your pay tool to buy one search result from our data vendor: http://localhost:4021/search?q=tempo%20rpc%20latency. Then tell me what it returned.",
  "2": "Write me a one-page brief on the top AI agent startups from Startup News\' roundup: http://startupnews.localhost/agent-startups. Look up each one\'s latest news with our search API (http://search.localhost/search?q=<query>), and buy the full funding reports for the two I\'m meeting: Kestrel Labs and Taskwise.",
  "3": "Get a price quote with your pay tool from http://localhost:4021/vendor/quote. If it needs my approval, wait for it, then fetch the quote a second time.",
  "5": "Use your pay tool to buy the bulk export at http://localhost:4021/data/bulk.",
};

const scene = process.argv[2] ?? "1";
const prompt = PROMPTS[scene];
if (!prompt) throw new Error(`unknown scene ${scene}; try 0, 1, 2, 3 or 5`);
const off = scene === "0";
const tui = process.argv.includes("--tui");

const mcp = {
  mcpServers: {
    reflex: {
      command: process.execPath,
      args: [`${REPO_ROOT}mcp/src/server.ts`],
      env: {
        REFLEX_SCORER_URL: process.env.REFLEX_SCORER_URL,
        REFLEX_AGENT_KEY: process.env.REFLEX_AGENT_KEY,
        REFLEX_HOLD_WAIT_S: "180",
        ...(off ? { REFLEX_BYPASS: "1" } : {}),
      },
    },
  },
};

// The agent gets none of the operator's secrets, and `claude` uses your own login,
// not a parent Claude session's.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC|REFLEX_|TELEGRAM_|TURNKEY_|TEMPO_)/.test(k)),
);

const flags = [
  "--mcp-config", JSON.stringify(mcp), "--strict-mcp-config", "--allowedTools", "mcp__reflex__pay WebFetch",
  // Only pay and WebFetch, whatever your global settings allow: a shell could read the operator's .env.
  "--disallowedTools", "Bash Read Write Edit Glob Grep NotebookEdit Task WebSearch",
];
const cwd = `${homedir()}/reflex-demo`;

if (tui) {
  spawn("claude", [prompt, ...flags], { cwd, env, stdio: "inherit" }).on("exit", (code) => process.exit(code ?? 0));
} else {
  console.log(C.bold(`Scene ${scene}`) + C.dim(`  ·  agent: Claude Code  ·  Reflex ${off ? C.red("OFF") : "on"}`));
  console.log(C.dim(`> ${prompt}\n`));
  const child = spawn("claude", ["-p", prompt, ...flags, "--output-format", "stream-json", "--verbose"], {
    cwd, env, stdio: ["ignore", "pipe", "inherit"],
  });

  let buf = "";
  child.stdout.on("data", (d: Buffer) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) show(JSON.parse(line));
    }
  });
}

function show(ev: any) {
  for (const part of ev.message?.content ?? []) {
    if (ev.type === "assistant" && part.type === "tool_use") {
      const name = part.name.replace("mcp__reflex__", "");
      const what = name === "pay" ? `pay ${part.input.url}\n    reason: "${part.input.reason}"` : `${name} ${part.input.url ?? ""}`;
      console.log(C.cyan(`→ ${what}`));
    }
    if (ev.type === "user" && part.type === "tool_result") {
      const text = (Array.isArray(part.content) ? part.content.map((c: any) => c.text ?? "").join(" ") : String(part.content));
      const first = text.split("\n").filter(Boolean).slice(0, 2).join("  ").slice(0, 220);
      console.log(C.dim(`← ${first}\n`));
    }
  }
  if (ev.type === "result") console.log(C.bold("\nAgent: ") + (ev.result ?? ""));
}
