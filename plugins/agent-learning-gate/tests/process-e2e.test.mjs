import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hookPath = path.join(pluginRoot, "bin", "agent-learning-gate-hook");
const cliPath = path.join(pluginRoot, "bin", "agent-learning-gate");

function withProject(t) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-learning-gate-process-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  return projectDir;
}

function runHook(input, projectDir, extraEnvironment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath], {
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        AGENT_LEARNING_GATE_STATE_DIR: path.join(projectDir, ".agent-learning-gate-test-state"),
        ...extraEnvironment,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

function proposal(projectDir, operation) {
  return {
    session_id: "session-e2e",
    evidence: {
      text: "Remember that this repository uses uv run pytest.",
      source_turn: "turn-e2e-1",
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
      source_turn: "turn-e2e-2",
      evidence: "Yes, save that exact rule.",
    },
  };
}

test("hook executable exits 0 for ordinary writes and 2 for protected writes", async (t) => {
  const projectDir = withProject(t);
  const ordinary = await runHook(
    {
      session_id: "session-e2e",
      tool_name: "Write",
      tool_input: { file_path: path.join(projectDir, "main.ts"), content: "x" },
    },
    projectDir,
  );
  assert.equal(ordinary.code, 0);
  assert.equal(ordinary.stdout, "");
  assert.equal(ordinary.stderr, "");

  const protectedResult = await runHook(
    {
      session_id: "session-e2e",
      tool_name: "Write",
      tool_input: { file_path: path.join(projectDir, "CLAUDE.md"), content: "x" },
    },
    projectDir,
  );
  assert.equal(protectedResult.code, 0);
  assert.equal(
    JSON.parse(protectedResult.stdout).hookSpecificOutput.permissionDecision,
    "deny",
  );
});

test("concurrent matching hooks consume exactly one permit", async (t) => {
  const projectDir = withProject(t);
  const targetPath = path.join(projectDir, "CLAUDE.md");
  const operation = {
    tool: "Write",
    file_path: targetPath,
    content: "Use uv run pytest.\n",
  };
  const document = proposal(projectDir, operation);
  const proposalPath = path.join(projectDir, "proposal.json");
  fs.writeFileSync(proposalPath, JSON.stringify(document));

  const authorize = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(pluginRoot, "bin", "agent-learning-gate"),
        "stage",
        proposalPath,
        "--project-dir",
        projectDir,
        "--host",
        "claude-code",
      ],
      {
        env: {
          ...process.env,
          AGENT_LEARNING_GATE_STATE_DIR: path.join(projectDir, ".agent-learning-gate-test-state"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
  assert.equal(authorize.code, 0, authorize.stderr);

  const hookInput = {
    session_id: "session-e2e",
    tool_name: "Write",
    tool_input: { file_path: targetPath, content: operation.content },
  };
  const results = await Promise.all([
    runHook(hookInput, projectDir),
    runHook(hookInput, projectDir),
  ]);
  assert.deepEqual(results.map((result) => result.code), [0, 0]);
  const decisions = results
    .map((result) => JSON.parse(result.stdout).hookSpecificOutput.permissionDecision)
    .sort();
  assert.deepEqual(decisions, ["ask", "deny"]);
});

test("session-bound permits reject a different session", async (t) => {
  const projectDir = withProject(t);
  const targetPath = path.join(projectDir, "CLAUDE.md");
  const operation = { tool: "Write", file_path: targetPath, content: "Rule.\n" };
  const document = proposal(projectDir, operation);
  const proposalPath = path.join(projectDir, "proposal.json");
  fs.writeFileSync(proposalPath, JSON.stringify(document));

  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(pluginRoot, "bin", "agent-learning-gate"),
        "stage",
        proposalPath,
        "--project-dir",
        projectDir,
        "--host",
        "claude-code",
      ],
      {
        env: {
          ...process.env,
          AGENT_LEARNING_GATE_STATE_DIR: path.join(projectDir, ".agent-learning-gate-test-state"),
        },
        stdio: "ignore",
      },
    );
    child.on("error", reject);
    child.on("close", resolve);
  });

  const result = await runHook(
    {
      session_id: "other-session",
      tool_name: "Write",
      tool_input: { file_path: targetPath, content: operation.content },
    },
    projectDir,
  );
  assert.equal(result.code, 0);
  assert.equal(
    JSON.parse(result.stdout).hookSpecificOutput.permissionDecision,
    "deny",
  );
});

test("proposal-dir creates private state outside the consumer repository", (t) => {
  const projectDir = withProject(t);
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-learning-gate-private-state-"));
  t.after(() => fs.rmSync(stateRoot, { recursive: true, force: true }));
  const result = spawnSync(
    process.execPath,
    [cliPath, "proposal-dir", "--project-dir", projectDir],
    {
      encoding: "utf8",
      env: { ...process.env, AGENT_LEARNING_GATE_STATE_DIR: stateRoot },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const directory = result.stdout.trim();
  assert.equal(path.relative(projectDir, directory).startsWith(".."), true);
  assert.equal(fs.statSync(directory).isDirectory(), true);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  }
});

test("CLI returns exit 4 for a schema-invalid proposal", (t) => {
  const projectDir = withProject(t);
  const invalidPath = path.join(projectDir, "invalid.json");
  fs.writeFileSync(
    invalidPath,
    JSON.stringify({
      evidence: {
        text: 123,
        kind: "EXPLICIT_REMEMBER",
        scope: "WORKSPACE",
        explicit_persistence: "false",
      },
      proposal: {
        target: "MEMORY",
        content: 456,
        scope: "WORKSPACE",
        durability: "STABLE",
      },
    }),
  );
  const result = spawnSync(process.execPath, [cliPath, "check", invalidPath], {
    encoding: "utf8",
  });
  assert.equal(result.status, 4, result.stderr);
  assert.match(result.stdout, /E001_INVALID_INPUT/);
});

test("hook process denies Write/Edit when custom destination config is invalid", async (t) => {
  const projectDir = withProject(t);
  const result = await runHook(
    {
      tool_name: "Write",
      tool_input: { file_path: path.join(projectDir, "ordinary.txt"), content: "x" },
      cwd: projectDir,
    },
    projectDir,
    { AGENT_LEARNING_GATE_EXTRA_DESTINATIONS: "{bad json" },
  );
  assert.equal(result.code, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /failed closed/i);
});

test("CLI exposes truthful host capability grades", () => {
  const result = spawnSync(process.execPath, [cliPath, "capabilities", "codex", "--format", "json"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const capability = JSON.parse(result.stdout);
  assert.equal(capability.host, "codex");
  assert.equal(capability.native_write_ask, false);
  assert.equal(capability.caller_prompt_approval, false);
  assert.equal(capability.enforcement, "deny-only-proposal-gate");
});

test("CLI records and verifies a non-authorizing Codex review receipt", (t) => {
  const projectDir = withProject(t);
  const command =
    "*** Begin Patch\n*** Add File: AGENTS.md\n+Use uv run pytest.\n*** End Patch";
  const document = proposal(projectDir, {
    tool: "apply_patch",
    adapter: "codex",
    command,
  });
  document.proposal.target = "AGENTS.md";
  const proposalPath = path.join(projectDir, "codex-proposal.json");
  fs.writeFileSync(proposalPath, JSON.stringify(document));
  const stateRoot = path.join(projectDir, "state");
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "review",
      proposalPath,
      "--project-dir",
      projectDir,
      "--host",
      "codex",
      "--format",
      "json",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, AGENT_LEARNING_GATE_STATE_DIR: stateRoot },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const reviewed = JSON.parse(result.stdout);
  assert.equal(reviewed.state, "REVIEWED");
  assert.equal(reviewed.authorizes_write, false);
  assert.equal(reviewed.operation.command, command);
  assert.equal(reviewed.validated_delta, "Use uv run pytest.");
  assert.equal(fs.existsSync(reviewed.receipt_path), true);

  const beforeApply = spawnSync(
    process.execPath,
    [cliPath, "verify", reviewed.receipt_path, "--format", "json"],
    { encoding: "utf8" },
  );
  assert.equal(beforeApply.status, 2, beforeApply.stderr);
  assert.equal(JSON.parse(beforeApply.stdout).state, "NOT_APPLIED");

  fs.writeFileSync(path.join(projectDir, "AGENTS.md"), "Use uv run pytest.\n");
  const afterApply = spawnSync(
    process.execPath,
    [cliPath, "verify", reviewed.receipt_path, "--format", "json"],
    { encoding: "utf8" },
  );
  assert.equal(afterApply.status, 0, afterApply.stderr);
  assert.equal(JSON.parse(afterApply.stdout).state, "VERIFIED");

  const tamperedPath = path.join(projectDir, "tampered-receipt.json");
  const tampered = JSON.parse(fs.readFileSync(reviewed.receipt_path, "utf8"));
  tampered.validated_delta = "tampered";
  fs.writeFileSync(tamperedPath, JSON.stringify(tampered));
  const tamperedResult = spawnSync(process.execPath, [cliPath, "verify", tamperedPath], {
    encoding: "utf8",
  });
  assert.equal(tamperedResult.status, 4);
  assert.match(tamperedResult.stderr, /integrity check failed/);
});

test("CLI refuses to stage Codex after a successful review", (t) => {
  const projectDir = withProject(t);
  const proposalPath = path.join(projectDir, "codex-proposal.json");
  const document = proposal(projectDir, {
    tool: "apply_patch",
    adapter: "codex",
    command: "*** Begin Patch\n*** Add File: AGENTS.md\n+Use uv run pytest.\n*** End Patch",
  });
  document.proposal.target = "AGENTS.md";
  fs.writeFileSync(proposalPath, JSON.stringify(document));
  const result = spawnSync(
    process.execPath,
    [cliPath, "stage", proposalPath, "--project-dir", projectDir, "--host", "codex"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 4);
  assert.match(result.stderr, /no trusted v0 approval channel/);
});
