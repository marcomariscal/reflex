// Reset between takes: clears payments and holds, unpauses the agent, restores trusted addresses.
import { reset } from "./lib.ts";

await reset();
console.log("reset: clean slate for amp-demo");
