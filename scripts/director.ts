// One terminal window for the whole recording: plays each scene in Claude Code's interface.
// The operator ends a scene by stopping its agent (pkill -f strict-mcp-config, or Ctrl-C twice in the
// window); the next one starts after `touch /tmp/reflex-next`. Usage: node scripts/director.ts [scenes]   default: 0 1 2 3 4
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { color as C, reset, sleep, REPO_ROOT } from "./lib.ts";

const NEXT = "/tmp/reflex-next";
const TITLES: Record<string, string> = {
  "0": "Without Reflex: the agent pays whoever asks",
  "1": "A normal payment goes straight through",
  "2": "A planted page talks the agent into paying a stranger",
  "3": "One Approve teaches Reflex",
  "4": "A runaway loop",
  "5": "The wallet's own $200 limit",
};
const scenes = process.argv.slice(2).length ? process.argv.slice(2) : ["0", "1", "2", "3", "4"];
const waitForNext = async () => {
  rmSync(NEXT, { force: true });
  while (!existsSync(NEXT)) await sleep(500);
  rmSync(NEXT, { force: true });
};

process.stdout.write("\x1b[2J\x1b[H");
console.log(C.bold("\n  Reflex") + C.dim("  ·  a payment firewall for AI agents") + "\n\n  Agent: Claude Code  ·  Approvals: Telegram  ·  Money: Tempo\n");
await waitForNext();

for (const [i, scene] of scenes.entries()) {
  if (scene === "0" || scene === "4") await reset();
  process.stdout.write("\x1b[2J\x1b[H");
  console.log(C.bold(`\n  Scene ${scene}`) + C.dim("  ·  Reflex") + "\n\n  " + TITLES[scene] + "\n");
  await sleep(2500);
  const script = scene === "4" ? ["loop.ts"] : ["agent.ts", scene, "--tui"];
  spawnSync(process.execPath, [`${REPO_ROOT}scripts/${script[0]}`, ...script.slice(1)], { stdio: "inherit" });
  if (i === scenes.length - 1) break;
  console.log(C.dim("\n  (waiting for the next scene)"));
  await waitForNext();
}
console.log(C.bold("\n  End of demo."));
