#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import { checkProposal } from "../plugins/agent-learning-gate/lib/engine.mjs";

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const input = path.resolve(arg("--input", ".agent-learning-gate/cursor-proposals.jsonl"));
const output = path.resolve(arg("--output", ".agent-learning-gate/proposal-decisions.jsonl"));
const records = fs
  .readFileSync(input, "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const evaluated = records.map((record) => ({
  id: record.id,
  input: record,
  result: checkProposal(record),
}));
fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
fs.writeFileSync(
  output,
  evaluated.map((record) => JSON.stringify(record)).join("\n") + "\n",
  { mode: 0o600 },
);
const byDecision = evaluated.reduce((counts, record) => {
  counts[record.result.decision] = (counts[record.result.decision] || 0) + 1;
  return counts;
}, {});
const byCode = evaluated.reduce((counts, record) => {
  for (const entry of record.result.issues) {
    counts[entry.code] = (counts[entry.code] || 0) + 1;
  }
  return counts;
}, {});
process.stdout.write(
  `${JSON.stringify({ input, output, total: evaluated.length, by_decision: byDecision, by_code: byCode }, null, 2)}\n`,
);
