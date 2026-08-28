#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jsonFiles = [
  ".agents/plugins/marketplace.json",
  ".claude-plugin/marketplace.json",
  ".cursor-plugin/marketplace.json",
  "eval/judge-output.schema.json",
  "plugins/agent-learning-gate/.claude-plugin/plugin.json",
  "plugins/agent-learning-gate/.codex-plugin/plugin.json",
  "plugins/agent-learning-gate/.cursor-plugin/plugin.json",
  "plugins/agent-learning-gate/hooks/claude-hooks.json",
  "plugins/agent-learning-gate/hooks/cursor-hooks.json",
  "plugins/agent-learning-gate/hooks/hooks.json",
  "plugins/agent-learning-gate/package.json",
  "plugins/agent-learning-gate/schemas/proposal.schema.json",
  "package.json",
];

for (const relative of jsonFiles) {
  const filePath = path.join(root, relative);
  JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const ids = new Set();
const benchmarkPath = path.join(root, "benchmark", "wrong-lessons-v0.jsonl");
const proposalSchema = JSON.parse(
  fs.readFileSync(path.join(root, "plugins/agent-learning-gate/schemas/proposal.schema.json"), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
const validateProposal = ajv.compile(proposalSchema);
for (const [index, line] of fs.readFileSync(benchmarkPath, "utf8").split(/\r?\n/).entries()) {
  if (!line.trim()) continue;
  const record = JSON.parse(line);
  if (!record.id) throw new Error(`Missing benchmark id at line ${index + 1}`);
  if (ids.has(record.id)) throw new Error(`Duplicate benchmark id ${record.id}`);
  ids.add(record.id);
  const document = Object.fromEntries(
    ["id", "session_id", "evidence", "current", "proposal", "user_confirmation"]
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, record[key]]),
  );
  if (!validateProposal(document)) {
    throw new Error(
      `Benchmark proposal fails schema at line ${index + 1}: ${ajv.errorsText(validateProposal.errors)}`,
    );
  }
}

process.stdout.write(`Validated ${jsonFiles.length} JSON files and ${ids.size} benchmark records.\n`);
