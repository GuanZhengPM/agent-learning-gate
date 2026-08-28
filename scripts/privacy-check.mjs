#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

function readableText(relative) {
  const absolute = path.join(root, relative);
  const value = fs.readFileSync(absolute);
  if (value.includes(0)) return null;
  return value.toString("utf8");
}

const privateTerms = String(process.env.AGENT_LEARNING_GATE_PRIVATE_TERMS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const localHome = os.homedir();
const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu;
const highConfidenceSecrets = [
  /AKIA[0-9A-Z]{16}/u,
  /github_pat_[0-9A-Za-z_]{20,}/u,
  /xox[baprs]-[0-9A-Za-z-]{10,}/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
];

for (const relative of trackedFiles()) {
  const text = readableText(relative);
  if (text === null) continue;
  if (localHome && text.includes(localHome)) {
    failures.push(`${relative}: contains the current home path`);
  }
  for (const term of privateTerms) {
    if (text.toLocaleLowerCase().includes(term.toLocaleLowerCase())) {
      failures.push(`${relative}: contains a configured private term`);
    }
  }
  for (const match of text.matchAll(emailPattern)) {
    const email = match[0].toLowerCase();
    if (!email.endsWith("@example.com") && !email.endsWith("@users.noreply.github.com")) {
      failures.push(`${relative}: contains a non-example email address`);
    }
  }
  if (highConfidenceSecrets.some((pattern) => pattern.test(text))) {
    failures.push(`${relative}: contains a high-confidence credential shape`);
  }
}

for (const relative of [".agent-learning-gate", ".claude/settings.local.json"]) {
  if (fs.existsSync(path.join(root, relative))) {
    failures.push(`${relative}: private local artifact is still present`);
  }
}

const authors = execFileSync("git", ["log", "--all", "--format=%an%x09%ae"], {
  cwd: root,
  encoding: "utf8",
}).split(/\r?\n/u).filter(Boolean);
const publicAuthors = new Set([
  "Agent Learning Gate Maintainers\tagent-learning-gate@users.noreply.github.com",
  "GuanZhengPM\t267539258+GuanZhengPM@users.noreply.github.com",
]);
for (const author of authors) {
  if (!publicAuthors.has(author)) {
    failures.push("Git history contains a non-public author identity");
    break;
  }
}

if (failures.length > 0) {
  process.stderr.write(`Privacy check failed:\n- ${[...new Set(failures)].join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Privacy check passed.\n");
}
