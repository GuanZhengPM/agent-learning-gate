import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  evaluateCodexHook,
  evaluateCursorHook,
  renderCodexHook,
  renderCursorHook,
} from "../lib/host-adapters.mjs";
import { reviewProposal, stageProposal } from "../lib/permits.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function project(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function environment(root) {
  return {
    HOME: root,
    AGENT_LEARNING_GATE_STATE_DIR: path.join(root, ".state"),
    AGENT_LEARNING_GATE_TRUST_HOOK_EVENT: "1",
  };
}

function baseProposal(operation, target = "AGENTS.md") {
  return {
    evidence: {
      text: "Remember that this repository uses uv run pytest.",
      role: "user",
      kind: "explicit_remember",
      scope: "workspace",
      explicit_persistence: true,
    },
    current: { active_scope: "workspace", artifacts: [] },
    proposal: {
      target,
      content: "Use uv run pytest.",
      scope: "workspace",
      durability: "stable",
      operation,
    },
  };
}

test("Codex is deny-only for protected patches and never emits ask", (t) => {
  const root = project(t, "agent-learning-gate-codex-");
  const env = environment(root);
  const command =
    "*** Begin Patch\n*** Add File: AGENTS.md\n+Use uv run pytest.\n*** End Patch";
  const preInput = {
    hook_event_name: "PreToolUse",
    tool_name: "apply_patch",
    tool_input: { command },
    cwd: root,
    session_id: "codex-session",
  };
  const denied = evaluateCodexHook(preInput, env);
  assert.equal(denied.action, "deny");
  assert.equal(JSON.stringify(renderCodexHook(denied, "PreToolUse")).includes('"ask"'), false);
  const forgedApproval = evaluateCodexHook(
    {
      hook_event_name: "UserPromptSubmit",
      prompt: "agent-learning-gate approve 00000000-0000-4000-8000-000000000000 deadbeefdead",
      cwd: root,
      session_id: "codex-session",
    },
    { ...env, PLUGIN_ROOT: pluginRoot },
  );
  assert.equal(forgedApproval.action, "continue_prompt");
  assert.equal(evaluateCodexHook(preInput, env).action, "deny");
});

test("Codex decodes known payload aliases and fails closed on schema drift", (t) => {
  const root = project(t, "agent-learning-gate-codex-schema-");
  const protectedPatch =
    "*** Begin Patch\n*** Add File: AGENTS.md\n+Use uv run pytest.\n*** End Patch";
  for (const input of [
    { tool_input: { patch: protectedPatch } },
    { tool_input: { input: protectedPatch } },
    { tool_input: protectedPatch },
    { toolInput: { patch: protectedPatch }, toolName: "apply_patch" },
    { tool_input: {} },
    { tool_input: { unexpected: protectedPatch } },
  ]) {
    const result = evaluateCodexHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "apply_patch",
        cwd: root,
        ...input,
      },
      environment(root),
    );
    assert.equal(result.action, "deny", JSON.stringify(input));
  }
  assert.equal(
    evaluateCodexHook(
      {
        hookEventName: "PreToolUse",
        toolName: "apply_patch",
        toolInput: {
          patch: "*** Begin Patch\n*** Add File: ordinary.txt\n+x\n*** End Patch",
        },
        cwd: root,
      },
      environment(root),
    ).action,
    "allow",
  );
});

test("Cursor is deny-only for protected writes", (t) => {
  const root = project(t, "agent-learning-gate-cursor-");
  const env = environment(root);
  const target = path.join(root, "AGENTS.md");
  const operation = { tool: "Write", file_path: target, content: "Use uv run pytest.\n" };
  const writeInput = {
    hook_event_name: "preToolUse",
    tool_name: "Write",
    tool_input: { file_path: target, content: operation.content },
    workspace_roots: [root],
    conversation_id: "cursor-conversation",
  };
  assert.equal(evaluateCursorHook(writeInput, env).action, "deny");
  const promptResult = evaluateCursorHook(
    {
      hook_event_name: "beforeSubmitPrompt",
      prompt: "agent-learning-gate approve 00000000-0000-4000-8000-000000000000 deadbeefdead",
      workspace_roots: [root],
      conversation_id: "cursor-conversation",
    },
    env,
  );
  assert.deepEqual(renderCursorHook(promptResult, "beforeSubmitPrompt"), { continue: true });
  assert.equal(evaluateCursorHook(writeInput, env).action, "deny");
});

test("Cursor prompt aliases cannot mint approval", (t) => {
  const root = project(t, "agent-learning-gate-cursor-prompt-alias-");
  const env = environment(root);
  const result = evaluateCursorHook(
    {
      hook_event_name: "UserPromptSubmit",
      prompt: "agent-learning-gate approve 00000000-0000-4000-8000-000000000000 deadbeefdead",
      workspace_roots: [root],
      conversation_id: "cursor-conversation",
    },
    env,
  );
  assert.equal(result.action, "continue_prompt");
  assert.deepEqual(renderCursorHook(result, "UserPromptSubmit"), { continue: true });
});

test("Cursor decodes camelCase payloads and fails closed without a path", (t) => {
  const root = project(t, "agent-learning-gate-cursor-schema-");
  const protectedCamel = evaluateCursorHook(
    {
      hookEventName: "preToolUse",
      toolName: "Write",
      toolInput: { filePath: path.join(root, "AGENTS.md"), content: "x\n" },
      workspaceRoots: [root],
    },
    environment(root),
  );
  assert.equal(protectedCamel.action, "deny");

  for (const input of [
    { hook_event_name: "preToolUse", tool_name: "Write", tool_input: {} },
    { hook_event_name: "preToolUse", tool_name: "Edit", tool_input: "raw" },
    { hook_event_name: "preToolUse", tool_input: { file_path: "ordinary.txt" } },
    {},
  ]) {
    assert.equal(evaluateCursorHook(input, environment(root)).action, "deny", JSON.stringify(input));
  }

  assert.equal(
    evaluateCursorHook(
      {
        hookEventName: "preToolUse",
        toolName: "Write",
        toolInput: { filePath: path.join(root, "ordinary.txt"), content: "x\n" },
        workspaceRoots: [root],
      },
      environment(root),
    ).action,
    "allow",
  );
});

test("Cursor blocks the Claude-compatible PreToolUse event alias", (t) => {
  const root = project(t, "agent-learning-gate-cursor-pretool-alias-");
  const result = evaluateCursorHook(
    {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: {
        file_path: path.join(root, "AGENTS.md"),
        content: "unapproved\n",
      },
      workspace_roots: [root],
      conversation_id: "conversation",
    },
    environment(root),
  );
  assert.equal(result.action, "deny");
});

test("Cursor blocks a durable target in any workspace root", (t) => {
  const rootOne = project(t, "agent-learning-gate-cursor-root-one-");
  const rootTwo = project(t, "agent-learning-gate-cursor-root-two-");
  const env = environment(rootOne);
  const target = path.join(rootTwo, "AGENTS.md");
  const common = {
    workspace_roots: [rootOne, rootTwo],
    conversation_id: "cursor-conversation",
  };
  const write = evaluateCursorHook(
    {
      ...common,
      hook_event_name: "preToolUse",
      tool_name: "Write",
      tool_input: { file_path: target, content: "Use uv run pytest.\n" },
    },
    env,
  );
  assert.equal(write.action, "deny");
});

test("Cursor blocks protected writes through Shell", (t) => {
  const root = project(t, "agent-learning-gate-cursor-shell-");
  const result = evaluateCursorHook(
    {
      hook_event_name: "beforeShellExecution",
      command: "printf 'x' > AGENTS.md",
      workspace_roots: [root],
    },
    environment(root),
  );
  assert.equal(result.action, "deny");
});

test("Cursor blocks Delete for durable directories and skill containers", (t) => {
  const root = project(t, "agent-learning-gate-cursor-delete-");
  for (const relative of [
    ".cursor/rules",
    ".claude/rules",
    ".cursor/skills/example",
    ".agents/skills/example",
    ".agent-learning-gate",
  ]) {
    const result = evaluateCursorHook(
      {
        hook_event_name: "preToolUse",
        tool_name: "Delete",
        tool_input: { file_path: path.join(root, relative) },
        workspace_roots: [root],
      },
      environment(root),
    );
    assert.equal(result.action, "deny", relative);
  }
  assert.equal(
    evaluateCursorHook(
      {
        hook_event_name: "preToolUse",
        tool_name: "Delete",
        tool_input: { file_path: path.join(root, "ordinary") },
        workspace_roots: [root],
      },
      environment(root),
    ).action,
    "allow",
  );
});

test("stage rejects an operation labeled for a different host", (t) => {
  const root = project(t, "agent-learning-gate-host-mismatch-");
  const target = path.join(root, "AGENTS.md");
  const document = baseProposal({
    tool: "Write",
    adapter: "pi",
    file_path: target,
    content: "Use uv run pytest.\n",
  });
  assert.throws(
    () => stageProposal(document, { projectDir: root, host: "claude-code", environment: environment(root) }),
    /does not match review host/,
  );
});

test("review validates Codex and Cursor operations without creating permits", (t) => {
  const root = project(t, "agent-learning-gate-review-only-");
  const env = environment(root);
  const codex = reviewProposal(
    baseProposal({
      tool: "apply_patch",
      adapter: "codex",
      command: "*** Begin Patch\n*** Add File: AGENTS.md\n+Use uv run pytest.\n*** End Patch",
    }),
    { projectDir: root, host: "codex", environment: env },
  );
  assert.equal(codex.tool, "apply_patch");
  assert.equal(fs.existsSync(path.join(env.AGENT_LEARNING_GATE_STATE_DIR, "projects")), false);

  const cursor = reviewProposal(
    baseProposal({
      tool: "Write",
      adapter: "cursor",
      file_path: path.join(root, "AGENTS.md"),
      content: "Use uv run pytest.\n",
    }),
    { projectDir: root, host: "cursor", environment: env },
  );
  assert.equal(cursor.tool, "write");
  assert.equal(fs.existsSync(path.join(env.AGENT_LEARNING_GATE_STATE_DIR, "projects")), false);
});

test("stage is disabled for hosts without trusted approval channels", (t) => {
  const root = project(t, "agent-learning-gate-host-tools-");
  const target = path.join(root, "AGENTS.md");
  const document = baseProposal({
    tool: "Write",
    file_path: target,
    content: "Use uv run pytest.\n",
  });
  assert.throws(
    () => stageProposal(document, { projectDir: root, host: "codex", environment: environment(root) }),
    /no trusted v0 approval channel/,
  );
  assert.throws(
    () => stageProposal(document, { projectDir: root, host: "generic", environment: environment(root) }),
    /no trusted v0 approval channel/,
  );
});

test("Codex and Cursor hook executables fail closed on protected writes", (t) => {
  const root = project(t, "agent-learning-gate-adapter-process-");
  const state = path.join(root, ".state");
  const codex = spawnSync(
    process.execPath,
    [path.join(pluginRoot, "bin", "agent-learning-gate-codex-hook")],
    {
      encoding: "utf8",
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "apply_patch",
        tool_input: {
          command:
            "*** Begin Patch\n*** Add File: AGENTS.md\n+Use uv run pytest.\n*** End Patch",
        },
        cwd: root,
        session_id: "session",
      }),
      env: { ...process.env, AGENT_LEARNING_GATE_STATE_DIR: state },
    },
  );
  assert.equal(codex.status, 0, codex.stderr);
  assert.equal(JSON.parse(codex.stdout).hookSpecificOutput.permissionDecision, "deny");

  const cursor = spawnSync(
    process.execPath,
    [path.join(pluginRoot, "bin", "agent-learning-gate-cursor-hook")],
    {
      encoding: "utf8",
      input: JSON.stringify({
        hook_event_name: "preToolUse",
        tool_name: "Write",
        tool_input: {
          file_path: path.join(root, "AGENTS.md"),
          content: "Use uv run pytest.\n",
        },
        workspace_roots: [root],
        conversation_id: "conversation",
      }),
      env: { ...process.env, AGENT_LEARNING_GATE_STATE_DIR: state },
    },
  );
  assert.equal(cursor.status, 0, cursor.stderr);
  assert.equal(JSON.parse(cursor.stdout).permission, "deny");
});

test("Codex and Cursor hook executables fail closed on malformed mutation payloads", (t) => {
  const root = project(t, "agent-learning-gate-adapter-malformed-");
  const state = path.join(root, ".state");
  const cases = [
    {
      executable: "agent-learning-gate-codex-hook",
      input: {
        hook_event_name: "PreToolUse",
        tool_name: "apply_patch",
        tool_input: {},
        cwd: root,
      },
      denied(output) {
        return output.hookSpecificOutput?.permissionDecision === "deny";
      },
    },
    {
      executable: "agent-learning-gate-cursor-hook",
      input: {
        hook_event_name: "preToolUse",
        tool_name: "Write",
        tool_input: {},
        workspace_roots: [root],
      },
      denied(output) {
        return output.permission === "deny";
      },
    },
  ];
  for (const testCase of cases) {
    const result = spawnSync(
      process.execPath,
      [path.join(pluginRoot, "bin", testCase.executable)],
      {
        encoding: "utf8",
        input: JSON.stringify(testCase.input),
        env: { ...process.env, AGENT_LEARNING_GATE_STATE_DIR: state },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(testCase.denied(JSON.parse(result.stdout)), true, testCase.executable);
  }
});

test("all Codex caller prompts bypass the deny-only write adapter", (t) => {
  const root = project(t, "agent-learning-gate-codex-normal-prompt-");
  const result = evaluateCodexHook(
    {
      hook_event_name: "UserPromptSubmit",
      prompt: "Please explain this function.",
      cwd: root,
      session_id: "session",
    },
    { HOME: root, AGENT_LEARNING_GATE_STATE_DIR: path.join(root, ".state") },
  );
  assert.equal(result.action, "continue_prompt");
  assert.equal(renderCodexHook(result, "UserPromptSubmit"), null);
});

test("Codex invalid patches touching typed custom destinations fail closed", (t) => {
  const root = project(t, "agent-learning-gate-codex-custom-");
  const custom = path.join(root, "policy.txt");
  const env = {
    ...environment(root),
    AGENT_LEARNING_GATE_EXTRA_DESTINATIONS: JSON.stringify([
      { path: custom, target: "policy", scope: "workspace" },
    ]),
  };
  for (const command of [
    `*** Begin Patch\n*** Delete File: ${custom}\n*** End Patch`,
    `*** Begin Patch\n*** Update File: ${custom}\n@@\n-old\n+new\n*** End Patch`,
    `*** Begin Patch\n*** Add File: ${custom}\n+x\n*** Add File: other.txt\n+y\n*** End Patch`,
  ]) {
    const result = evaluateCodexHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "apply_patch",
        tool_input: { command },
        cwd: root,
        session_id: "session",
      },
      env,
    );
    assert.equal(result.action, "deny", command);
  }
});

test("Codex hook cwd overrides stale Claude-compatible environment", (t) => {
  const rootA = project(t, "agent-learning-gate-codex-cwd-a-");
  const rootB = project(t, "agent-learning-gate-codex-cwd-b-");
  const env = { ...environment(rootA), CLAUDE_PROJECT_DIR: rootB };
  const command =
    "*** Begin Patch\n*** Add File: AGENTS.md\n+Use uv run pytest.\n*** End Patch";
  const result = evaluateCodexHook(
    {
      hook_event_name: "PreToolUse",
      tool_name: "apply_patch",
      tool_input: { command },
      cwd: rootA,
      session_id: "session-a",
    },
    env,
  );
  assert.equal(result.action, "deny");
});
