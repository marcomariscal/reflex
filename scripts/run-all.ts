// Runs the scenes in recording order and prints a summary table.
// Order (shot list): 1 normal -> 3 poisoned -> 5 approve-learns -> 4 loop -> (5) backstop.
// Script order here per the task: 01, 03, 05, 02, 04.

import { color as C, failureCount, resetChecks, note } from "./lib.ts";
import { main as s01 } from "./01-one-payment.ts";
import { main as s03 } from "./03-poisoned-pay.ts";
import { main as s05 } from "./05-approve-learns.ts";
import { main as s02 } from "./02-loop-50.ts";
import { main as s04 } from "./04-cap-200.ts";

type Scene = { id: string; name: string; run: () => Promise<void> };

const SCENES: Scene[] = [
  { id: "01", name: "normal payment signs", run: s01 },
  { id: "03", name: "poisoned pay held + denied", run: s03 },
  { id: "05", name: "approve teaches baseline", run: s05 },
  { id: "02", name: "runaway loop trips once", run: s02 },
  { id: "04", name: "$200 backstop (cap hold)", run: s04 },
];

type Row = { id: string; name: string; failed: number; error?: string };

const rows: Row[] = [];

for (const scene of SCENES) {
  console.log("\n" + C.bold(C.cyan(`===== scene ${scene.id}: ${scene.name} =====`)));
  resetChecks();
  try {
    await scene.run();
    rows.push({ id: scene.id, name: scene.name, failed: failureCount() });
  } catch (e) {
    rows.push({ id: scene.id, name: scene.name, failed: -1, error: (e as Error).message });
    console.log(C.red("scene threw: ") + (e as Error).message);
  }
}

console.log("\n" + C.bold("SUMMARY"));
console.log("-".repeat(52));
let anyFail = false;
for (const r of rows) {
  let status: string;
  if (r.failed === -1) {
    status = C.red("ERROR");
    anyFail = true;
  } else if (r.failed === 0) {
    status = C.green("PASS");
  } else {
    status = C.red(`FAIL (${r.failed})`);
    anyFail = true;
  }
  console.log(`  ${r.id}  ${r.name.padEnd(32)}  ${status}${r.error ? C.dim("  " + r.error) : ""}`);
}
console.log("-".repeat(52));

note("Scene 04 backstop is UNPROVEN in stub mode (REFLEX_SIGNER=stub); needs live Turnkey keys.");
note("Scene 02 'exactly one card' is shown via a single clean cliff + one resume clearing all holds (the feed has no card-emission field).");

if (anyFail) {
  console.log(C.red(C.bold("\nSome scenes failed.")));
  process.exitCode = 1;
} else {
  console.log(C.green(C.bold("\nAll scenes green.")));
}
