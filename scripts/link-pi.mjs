// Dev-only: pi supplies @earendil-works/pi-ai at runtime, so it is a peer
// dependency. For tests and typechecking, symlink the copy bundled with the
// globally installed pi instead of installing a second one.
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

const piBin = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
let dir = dirname(piBin);
while (!dir.endsWith(join("@earendil-works", "pi-coding-agent"))) {
  const parent = dirname(dir);
  if (parent === dir) throw new Error(`could not locate pi-coding-agent from ${piBin}`);
  dir = parent;
}
const targets = {
  "pi-coding-agent": dir,
  "pi-ai": join(dir, "node_modules", "@earendil-works", "pi-ai"),
};
const scope = join(process.cwd(), "node_modules", "@earendil-works");
mkdirSync(scope, { recursive: true });
for (const [name, target] of Object.entries(targets)) {
  const link = join(scope, name);
  rmSync(link, { force: true, recursive: true });
  symlinkSync(realpathSync(target), link, "dir");
  console.log(`${link} -> ${realpathSync(target)}`);
}
