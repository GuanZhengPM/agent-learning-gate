import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = path.join(repositoryRoot, "plugins", "agent-learning-gate", "tests");
const files = fs
  .readdirSync(testRoot)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => path.join(testRoot, name));

if (files.length === 0) {
  process.stderr.write(`No tests found under ${testRoot}\n`);
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ["--test", ...files], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
