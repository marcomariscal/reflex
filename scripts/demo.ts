// `npm start`: the whole local demo in one command. Installs the two packages' deps if they're
// missing, then runs the merchant (paid sites) and the stage (one-screen view) until Ctrl-C.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const log = (msg: string) => console.log(`[demo] ${msg}`);

for (const pkg of ["mcp", "scripts"]) {
  if (existsSync(`${root}${pkg}/node_modules`)) continue;
  log(`installing ${pkg}/ dependencies (first run only)`);
  const r = spawnSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: `${root}${pkg}`, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
if (!existsSync(`${root}.env`)) log("no .env yet: `cp .env.example .env` and fill in the keys (the sites run without it; scorer calls won't)");

const procs = ["merchant/server.ts", "stage/server.ts"].map((f) => spawn(process.execPath, [`${root}${f}`], { cwd: root, stdio: "inherit" }));
const stop = () => procs.forEach((p) => p.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const p of procs) {
  p.on("exit", (code) => {
    if (code) {
      stop();
      process.exit(code);
    }
  });
}
log("paid sites on localhost:4021 (+ port 80), stage on http://localhost:4030; Ctrl-C stops both");
