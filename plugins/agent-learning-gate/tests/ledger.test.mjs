import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  activeEntries,
  appendEntry,
  evaluateLedgerHook,
  initLedger,
  ledgerEnabled,
  parseLedger,
  readLedger,
  recordNone,
  renderLedgerContext,
  renderLedgerHook,
} from "../lib/ledger.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(pluginRoot, "bin", "agent-learning-gate");
const hookPath = path.join(pluginRoot, "bin", "agent-learning-gate-ledger-hook");

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-learning-gate-ledger-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function environment(root, extra = {}) {
  return {
    AGENT_LEARNING_GATE_STATE_DIR: path.join(root, ".state"),
    CLAUDE_PROJECT_DIR: root,
    ...extra,
  };
}

function event(name, sessionId, root, extra = {}) {
  return { hook_event_name: name, session_id: sessionId, cwd: root, ...extra };
}

test("parses entries and hides superseded ones", () => {
  const text = [
    "# Decision ledger",
    "",
    "## [rejected] Regex parser",
    "- when: 2026-09-08T00:00:00Z",
    "- why: timezone edge cases",
    "- source: tool",
    "",
    "## [constraint] Do not modify config/",
    "- why: owned by another team",
    "- source: user",
    "",
    "## [superseded] config/ is shared now",
    "- supersedes: do not modify CONFIG/",
    "",
    "## [bogus] ignored",
    "- why: unknown kind",
  ].join("\n");
  const entries = parseLedger(text);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].fields.why, "timezone edge cases");
  const active = activeEntries(entries);
  assert.deepEqual(
    active.map((entry) => entry.title),
    ["Regex parser"],
  );
});

test("append creates the file, validates input, and round-trips", (t) => {
  const root = project(t);
  const env = environment(root);
  assert.equal(ledgerEnabled(root, env), false);
  assert.throws(() => appendEntry(root, { kind: "nope", title: "x", why: "y" }, env), /Unsupported ledger kind/);
  assert.throws(() => appendEntry(root, { kind: "rejected", title: "x" }, env), /--why/);
  assert.throws(() => appendEntry(root, { kind: "superseded", title: "x" }, env), /--supersedes/);
  appendEntry(root, { kind: "rejected", title: "Use\nregex", why: "slow\nand wrong", source: "tool" }, env);
  assert.equal(ledgerEnabled(root, env), true);
  assert.equal(ledgerEnabled(root, { ...env, AGENT_LEARNING_GATE_LEDGER: "off" }), false);
  const ledger = readLedger(root, env);
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.entries[0].title, "Use regex");
  assert.equal(ledger.entries[0].fields.why, "slow and wrong");
  assert.match(renderLedgerContext(ledger.entries), /rejected: Use regex \(slow and wrong\) \[tool\]/);
  assert.equal(renderLedgerContext([]), "");
});

test("hooks stay silent when the project has no ledger", (t) => {
  const root = project(t);
  const env = environment(root);
  const result = evaluateLedgerHook(event("SessionStart", "s1", root), "claude-code", env);
  assert.equal(result.action, "none");
  assert.equal(renderLedgerHook(result), null);
});

test("Claude flow: inject once, block stop once after work, then release", (t) => {
  const root = project(t);
  const env = environment(root);
  appendEntry(root, { kind: "veto", title: "No new dependencies", why: "user said so", source: "user" }, env);

  const start = evaluateLedgerHook(event("SessionStart", "s1", root, { source: "startup" }), "claude-code", env);
  assert.equal(start.action, "inject");
  assert.deepEqual(Object.keys(renderLedgerHook(start)), ["hookSpecificOutput"]);
  assert.equal(renderLedgerHook(start).hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(renderLedgerHook(start).hookSpecificOutput.additionalContext, /veto: No new dependencies/);

  const prompt = evaluateLedgerHook(event("UserPromptSubmit", "s1", root, { prompt: "go" }), "claude-code", env);
  assert.equal(prompt.action, "none", "unchanged ledger is not re-injected on every prompt");

  const earlyStop = evaluateLedgerHook(event("Stop", "s1", root), "claude-code", env);
  assert.equal(earlyStop.action, "none", "a session that did no work is never blocked");

  evaluateLedgerHook(event("PostToolUse", "s1", root, { tool_name: "Bash" }), "claude-code", env);
  const stop = evaluateLedgerHook(event("Stop", "s1", root), "claude-code", env);
  assert.equal(stop.action, "block");
  assert.deepEqual(renderLedgerHook(stop), { decision: "block", reason: stop.reason });
  assert.match(stop.reason, /ledger add --project-dir/);

  const stopAgain = evaluateLedgerHook(event("Stop", "s1", root), "claude-code", env);
  assert.equal(stopAgain.action, "none", "blocks at most once per session");

  const stopActive = evaluateLedgerHook(
    event("Stop", "s2", root, { stop_hook_active: true }),
    "claude-code",
    env,
  );
  assert.equal(stopActive.action, "none");
});

test("appending to the ledger or recording none satisfies the stop hook", (t) => {
  const root = project(t);
  const env = environment(root);
  initLedger(root, env);

  evaluateLedgerHook(event("PostToolUse", "a", root, { tool_name: "Edit" }), "claude-code", env);
  appendEntry(root, { kind: "failed", title: "pytest -x on CI image", why: "missing libpq", source: "tool" }, env);
  assert.equal(evaluateLedgerHook(event("Stop", "a", root), "claude-code", env).action, "none");

  evaluateLedgerHook(event("PostToolUse", "b", root, { tool_name: "Edit" }), "claude-code", env);
  recordNone(root, "pure rename", env);
  assert.equal(evaluateLedgerHook(event("Stop", "b", root), "claude-code", env).action, "none");

  evaluateLedgerHook(event("PostToolUse", "c", root, { tool_name: "Edit" }), "claude-code", env);
  assert.equal(
    evaluateLedgerHook(event("Stop", "c", root), "claude-code", { ...env, AGENT_LEARNING_GATE_LEDGER_ENFORCE: "0" }).action,
    "none",
    "enforcement can be switched off while injection stays on",
  );
});

test("a ledger changed mid-session is re-injected on the next prompt", (t) => {
  const root = project(t);
  const env = environment(root);
  initLedger(root, env);
  assert.equal(evaluateLedgerHook(event("SessionStart", "s", root), "claude-code", env).action, "none");
  appendEntry(root, { kind: "rejected", title: "Option A", why: "too slow", source: "agent" }, env);
  const prompt = evaluateLedgerHook(event("UserPromptSubmit", "s", root, { prompt: "next" }), "claude-code", env);
  assert.equal(prompt.action, "inject");
  assert.equal(renderLedgerHook(prompt).hookSpecificOutput.hookEventName, "UserPromptSubmit");
});

test("Cursor flow uses conversation_id, workspace_roots, additional_context and followup_message", (t) => {
  const root = project(t);
  const env = { AGENT_LEARNING_GATE_STATE_DIR: path.join(root, ".state") };
  appendEntry(root, { kind: "constraint", title: "Keep Node 18 support", why: "CI matrix", source: "user" }, env);
  const base = { conversation_id: "conv-1", workspace_roots: [root] };
  const start = evaluateLedgerHook({ hook_event_name: "sessionStart", ...base }, "cursor", env);
  assert.deepEqual(Object.keys(renderLedgerHook(start)), ["additional_context"]);
  const prompt = evaluateLedgerHook({ hook_event_name: "beforeSubmitPrompt", prompt: "x", ...base }, "cursor", env);
  assert.equal(prompt.action, "none", "Cursor cannot inject on prompt submit");
  evaluateLedgerHook({ hook_event_name: "afterShellExecution", command: "ls", ...base }, "cursor", env);
  const stop = evaluateLedgerHook({ hook_event_name: "stop", status: "completed", loop_count: 0, ...base }, "cursor", env);
  assert.deepEqual(Object.keys(renderLedgerHook(stop)), ["followup_message"]);
  const looped = evaluateLedgerHook(
    { hook_event_name: "stop", status: "completed", loop_count: 1, conversation_id: "conv-2", workspace_roots: [root] },
    "cursor",
    env,
  );
  assert.equal(looped.action, "none");
});

test("Codex flow renders the shared block shape", (t) => {
  const root = project(t);
  const env = { AGENT_LEARNING_GATE_STATE_DIR: path.join(root, ".state") };
  initLedger(root, env);
  evaluateLedgerHook(event("PostToolUse", "cx", root, { tool_name: "exec" }), "codex", env);
  const stop = evaluateLedgerHook(event("Stop", "cx", root, { turn_id: "t1" }), "codex", env);
  assert.equal(renderLedgerHook(stop).decision, "block");
});

test("hook process fails open on malformed input and CLI round-trips", (t) => {
  const root = project(t);
  const env = { ...process.env, ...environment(root) };
  const malformed = spawnSync(process.execPath, [hookPath], { input: "{not json", env, encoding: "utf8" });
  assert.equal(malformed.status, 0);
  assert.equal(malformed.stdout, "");
  assert.match(malformed.stderr, /skipped/);

  const add = spawnSync(
    process.execPath,
    [cliPath, "ledger", "add", "--project-dir", root, "--kind", "rejected", "--title", "Plan B", "--why", "fails tests", "--source", "tool", "--format", "json"],
    { env, encoding: "utf8" },
  );
  assert.equal(add.status, 0, add.stderr);
  assert.equal(JSON.parse(add.stdout).entry.title, "Plan B");
  const list = spawnSync(process.execPath, [cliPath, "ledger", "list", "--project-dir", root, "--format", "json"], {
    env,
    encoding: "utf8",
  });
  assert.equal(JSON.parse(list.stdout).entries.length, 1);
  const none = spawnSync(process.execPath, [cliPath, "ledger", "none", "--project-dir", root], { env, encoding: "utf8" });
  assert.equal(none.status, 4, "none without --reason is invalid input");
});
