#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const input = path.resolve(arg("--input", ".agent-learning-gate/local-feedback-candidates.jsonl"));
const output = path.resolve(arg("--output", ".agent-learning-gate/local-holdout-inputs.jsonl"));
const ids = new Set(
  String(arg("--ids", ""))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

if (ids.size === 0) throw new Error("--ids requires a comma-separated list.");
const records = fs
  .readFileSync(input, "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const selected = records.filter((record) => ids.has(record.candidate_id));
const found = new Set(selected.map((record) => record.candidate_id));
const missing = [...ids].filter((id) => !found.has(id));
if (missing.length) throw new Error(`Unknown candidate ids: ${missing.join(", ")}`);
fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
fs.writeFileSync(
  output,
  selected.map((record) => JSON.stringify(record)).join("\n") + "\n",
  { mode: 0o600 },
);
process.stdout.write(`${JSON.stringify({ output, selected: selected.length }, null, 2)}\n`);
