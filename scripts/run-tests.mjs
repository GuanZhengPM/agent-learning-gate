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

// The suite must not depend on where it is launched from. A host agent (Claude
// Code, Codex, Cursor) exports session, project, and state variables that the
// engine honours at runtime: a permit staged under an ambient session id is then
// refused to a consumer that passes none, and the permit tests fail only inside
// an agent session. Scrub those variables before spawning the test process.
const AMBIENT_HOST_VARIABLES = [
  "AGENT_LEARNING_GATE_SESSION_ID",
  "AGENT_LEARNING_GATE_STATE_DIR",
  "AGENT_LEARNING_GATE_LEDGER",
  "AGENT_LEARNING_GATE_LEDGER_FILE",
  "AGENT_LEARNING_GATE_LEDGER_ENFORCE",
  "AGENT_LEARNING_GATE_EXTRA_DESTINATIONS",
  "AGENT_LEARNING_GATE_TRUST_HOOK_EVENT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_SESSION_ID",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_PLUGIN_ROOT",
  "CURSOR_PROJECT_DIR",
  "CURSOR_PLUGIN_ROOT",
  "PLUGIN_ROOT",
];
const environment = { ...process.env };
for (const name of AMBIENT_HOST_VARIABLES) delete environment[name];

if (files.length === 0) {
  process.stderr.write(`No tests found under ${testRoot}\n`);
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ["--test", ...files], {
    cwd: repositoryRoot,
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
