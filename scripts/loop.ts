// Scene 4 driver: an agent stuck in a loop fires 50 paid searches through the real pay tool.
// Expect: the first 25 go through, then Reflex pauses the agent and sends ONE card.
// Tap Resume or Keep paused on your phone to finish the scene.
import { color as C, MERCHANT_URL, startMcp } from "./lib.ts";

const N = 50;
const mcp = await startMcp({ REFLEX_HOLD_WAIT_S: "1" });
try {
  for (let i = 1; i <= N; i++) {
    const text = await mcp.pay(`${MERCHANT_URL}/search?q=loop-${i}`, `retrying the search, attempt ${i} of ${N}`);
    const held = /held|paused/i.test(text);
    console.log(`${String(i).padStart(2)}  ${held ? C.yellow("waiting for you") : C.green("paid")}`);
  }
} finally {
  await mcp.close();
}
console.log(C.bold("\nCheck Telegram: one card, not 40. Tap Resume or Keep paused."));
