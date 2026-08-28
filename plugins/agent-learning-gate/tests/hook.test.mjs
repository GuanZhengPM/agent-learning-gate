import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  evaluateHook,
  isProtectedBashWrite,
  isProtectedLearningPath,
} from "../lib/hook.mjs";
import { stageProposal } from "../lib/permits.mjs";

function withProject(t) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-learning-gate-hook-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  return projectDir;
}

function environment(projectDir, extra = {}) {
  return {
    CLAUDE_PROJECT_DIR: projectDir,
    AGENT_LEARNING_GATE_STATE_DIR: path.join(projectDir, ".agent-learning-gate-test-state"),
    ...extra,
  };
}

test("classifies protected and ordinary paths", () => {
  assert.equal(isProtectedLearningPath("/repo/CLAUDE.md"), true);
  assert.equal(isProtectedLearningPath("/repo/AGENTS.md"), true);
  assert.equal(isProtectedLearningPath("/repo/.claude/rules/tests.md"), true);
  assert.equal(isProtectedLearningPath("/repo/.claude/skills/release/SKILL.md"), true);
  assert.equal(isProtectedLearningPath("/repo/.agents/skills/release/SKILL.md"), true);
  assert.equal(isProtectedLearningPath("/repo/.cursor/rules/team.mdc"), true);
  assert.equal(isProtectedLearningPath("/repo/.cursor/skills/release/SKILL.md"), true);
  assert.equal(isProtectedLearningPath("/repo/.pi/skills/release/SKILL.md"), true);
  assert.equal(isProtectedLearningPath("/repo/.pi/SYSTEM.md"), true);
  assert.equal(isProtectedLearningPath("/repo/AGENTS.override.md"), true);
  assert.equal(isProtectedLearningPath("/repo/.cursorrules"), true);
  assert.equal(isProtectedLearningPath("/home/me/.claude/agent-memory/reviewer/MEMORY.md"), true);
  assert.equal(isProtectedLearningPath("/repo/src/main.ts"), false);
  assert.equal(isProtectedLearningPath("/repo/docs/CLAUDE.md.example"), false);
  assert.equal(isProtectedLearningPath("/repo/.claude/skills/release/helper.py"), false);
});

test("allows an ordinary source write without proposal state", (t) => {
  const projectDir = withProject(t);
  const result = evaluateHook(
    {
      tool_name: "Write",
      tool_input: { file_path: path.join(projectDir, "src", "main.ts"), content: "x" },
      cwd: projectDir,
    },
    environment(projectDir),
  );
  assert.equal(result.action, "allow");
  assert.equal(result.protected, false);
});

test("Claude Hook decodes camelCase and fails closed without a write path", (t) => {
  const projectDir = withProject(t);
  assert.equal(
    evaluateHook(
      {
        toolName: "Write",
        toolInput: { filePath: path.join(projectDir, "src", "main.ts"), content: "x" },
        cwd: projectDir,
      },
      environment(projectDir),
    ).action,
    "allow",
  );
  for (const input of [
    { tool_name: "Write", tool_input: {} },
    { tool_name: "Edit", tool_input: "raw" },
    {},
  ]) {
    assert.equal(evaluateHook(input, environment(projectDir)).action, "deny");
  }
});

test("denies an unpermitted CLAUDE.md write", (t) => {
  const projectDir = withProject(t);
  const result = evaluateHook(
    {
      tool_name: "Write",
      tool_input: { file_path: path.join(projectDir, "CLAUDE.md"), content: "Always use npm.\n" },
      cwd: projectDir,
    },
    environment(projectDir),
  );
  assert.equal(result.action, "deny");
  assert.match(result.reason, /unapproved durable-learning write/i);
});

test("asks once for one exact staged write then denies replay", (t) => {
  const projectDir = withProject(t);
  const operation = {
    tool: "Write",
    file_path: path.join(projectDir, "CLAUDE.md"),
    content: "Use uv run pytest.\n",
  };
  const document = {
    evidence: {
      text: "Remember that this repository uses uv run pytest.",
      source_turn: "turn-hook-1",
      kind: "explicit_remember",
      scope: "workspace",
      explicit_persistence: true,
    },
    current: { artifacts: [] },
    proposal: {
      target: "CLAUDE.md",
      content: "Use uv run pytest.",
      scope: "workspace",
      durability: "stable",
      operation,
    },
    user_confirmation: {
      confirmed: true,
      evidence: "Save that exact rule.",
    },
  };
  stageProposal(document, { projectDir, environment: environment(projectDir) });
  const hookInput = {
    tool_name: "Write",
    tool_input: { file_path: operation.file_path, content: operation.content },
    cwd: projectDir,
  };
  assert.equal(
    evaluateHook(hookInput, environment(projectDir)).action,
    "ask",
  );
  assert.equal(
    evaluateHook(hookInput, environment(projectDir)).action,
    "deny",
  );
});

test("optional Bash classifier recognizes a narrow set of direct writes", () => {
  assert.equal(isProtectedBashWrite("printf x > CLAUDE.md"), true);
  assert.equal(isProtectedBashWrite("sed -i '' s/a/b/ .claude/rules/test.md"), true);
  assert.equal(isProtectedBashWrite("printf x > .cursorrules"), true);
  assert.equal(isProtectedBashWrite("tee .cursor/rules/team.mdc"), true);
  assert.equal(isProtectedBashWrite("printf x > .pi/SYSTEM.md"), true);
  assert.equal(isProtectedBashWrite("cat CLAUDE.md"), false);
  assert.equal(isProtectedBashWrite("cat src/main.ts"), false);
});

test("typed custom destinations are protected by the same registry used for staging", (t) => {
  const projectDir = withProject(t);
  const customRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-learning-gate-custom-memory-"));
  t.after(() => fs.rmSync(customRoot, { recursive: true, force: true }));
  const result = evaluateHook(
    {
      tool_name: "Write",
      tool_input: {
        file_path: path.join(customRoot, "MEMORY.md"),
        content: "A durable fact.\n",
      },
      cwd: projectDir,
    },
    environment(projectDir, {
      AGENT_LEARNING_GATE_EXTRA_DESTINATIONS: JSON.stringify([
        { path: customRoot, target: "memory", scope: "global" },
      ]),
    }),
  );
  assert.equal(result.action, "deny");
  assert.equal(result.protected, true);
});

test("invalid custom destination configuration fails closed", (t) => {
  const projectDir = withProject(t);
  const hookInput = {
    tool_name: "Write",
    tool_input: { file_path: path.join(projectDir, "ordinary.txt"), content: "x" },
    cwd: projectDir,
  };
  assert.throws(
    () =>
      evaluateHook(
        hookInput,
        environment(projectDir, { AGENT_LEARNING_GATE_EXTRA_DESTINATIONS: "{bad json" }),
      ),
    /Invalid AGENT_LEARNING_GATE_EXTRA_DESTINATIONS/,
  );
  assert.throws(
    () =>
      evaluateHook(
        hookInput,
        environment(projectDir, {
          AGENT_LEARNING_GATE_EXTRA_DESTINATIONS: JSON.stringify([
            { path: "/tmp/custom", target: "memroy", scope: "global" },
          ]),
        }),
      ),
    /Invalid AGENT_LEARNING_GATE_EXTRA_DESTINATIONS/,
  );
});

test(
  "retargeting a protected symlink invalidates an exact staged request",
  { skip: process.platform === "win32" ? "requires file-symlink privileges" : false },
  (t) => {
  const projectDir = withProject(t);
  const first = path.join(projectDir, "first.md");
  const second = path.join(projectDir, "second.md");
  const linked = path.join(projectDir, "CLAUDE.md");
  fs.writeFileSync(first, "");
  fs.writeFileSync(second, "");
  fs.symlinkSync(first, linked);
  const operation = {
    tool: "Write",
    file_path: linked,
    content: "Use uv run pytest.\n",
  };
  const document = {
    evidence: {
      text: "Remember that this repository uses uv run pytest.",
      kind: "explicit_remember",
      scope: "workspace",
      explicit_persistence: true,
    },
    current: { artifacts: [] },
    proposal: {
      target: "CLAUDE.md",
      content: "Use uv run pytest.",
      scope: "workspace",
      durability: "stable",
      operation,
    },
  };
  stageProposal(document, { projectDir, environment: environment(projectDir) });
  fs.unlinkSync(linked);
  fs.symlinkSync(second, linked);
  const result = evaluateHook(
    { tool_name: "Write", tool_input: operation, cwd: projectDir },
    environment(projectDir),
  );
  assert.equal(result.action, "deny");
  },
);
