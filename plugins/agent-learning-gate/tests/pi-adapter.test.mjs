import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import agentLearningGatePiExtension from "../adapters/pi/index.js";
import { stageProposal } from "../lib/permits.mjs";

function setupExtension() {
  const handlers = new Map();
  const commands = new Map();
  agentLearningGatePiExtension({
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
  });
  return { handlers, commands };
}

function proposal(target) {
  return {
    evidence: {
      text: "Remember that this repository uses uv run pytest.",
      kind: "explicit_remember",
      scope: "workspace",
      explicit_persistence: true,
    },
    current: { artifacts: [] },
    proposal: {
      target: "AGENTS.md",
      content: "Use uv run pytest.",
      scope: "workspace",
      durability: "stable",
      operation: {
        tool: "Write",
        adapter: "pi",
        file_path: target,
        content: "Use uv run pytest.\n",
      },
    },
  };
}

test("Pi fails closed when a mutating event has no path", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-learning-gate-pi-malformed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { handlers } = setupExtension();
  const context = {
    cwd: root,
    hasUI: true,
    sessionManager: { getSessionId: () => "pi-session" },
    ui: { setStatus() {}, select: async () => "Allow once" },
  };
  for (const event of [
    { toolName: "write", input: { content: "x" } },
    { toolName: "edit", input: { edits: [] } },
  ]) {
    const result = await handlers.get("tool_call")(event, context);
    assert.equal(result.block, true);
    assert.match(result.reason, /no decodable target path/i);
  }
});

test("Pi uses deny-first UI for one exact staged write", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-learning-gate-pi-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previousState = process.env.AGENT_LEARNING_GATE_STATE_DIR;
  const previousSession = process.env.AGENT_LEARNING_GATE_SESSION_ID;
  process.env.AGENT_LEARNING_GATE_STATE_DIR = path.join(root, ".state");
  t.after(() => {
    if (previousState === undefined) delete process.env.AGENT_LEARNING_GATE_STATE_DIR;
    else process.env.AGENT_LEARNING_GATE_STATE_DIR = previousState;
    if (previousSession === undefined) delete process.env.AGENT_LEARNING_GATE_SESSION_ID;
    else process.env.AGENT_LEARNING_GATE_SESSION_ID = previousSession;
  });
  const target = path.join(root, "AGENTS.md");
  const { handlers } = setupExtension();
  const context = {
    cwd: root,
    hasUI: true,
    signal: undefined,
    sessionManager: { getSessionId: () => "pi-session" },
    ui: {
      setStatus() {},
      select: async (_title, options) => options[1],
    },
  };
  await handlers.get("session_start")({}, context);
  stageProposal(proposal(target), {
    projectDir: root,
    host: "pi",
    environment: process.env,
    sessionId: "pi-session",
  });
  const event = {
    toolName: "write",
    input: { path: target, content: "Use uv run pytest.\n" },
  };
  assert.equal(await handlers.get("tool_call")(event, context), undefined);
  assert.equal(Object.isFrozen(event.input), true);
  assert.throws(() => {
    event.input.content = "mutated";
  }, TypeError);
  const replay = await handlers.get("tool_call")(
    { toolName: "write", input: { path: target, content: "Use uv run pytest.\n" } },
    context,
  );
  assert.equal(replay.block, true);
});

test("Pi print mode denies without consuming a staged permit", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-learning-gate-pi-print-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, AGENT_LEARNING_GATE_STATE_DIR: path.join(root, ".state") };
  const previousState = process.env.AGENT_LEARNING_GATE_STATE_DIR;
  process.env.AGENT_LEARNING_GATE_STATE_DIR = env.AGENT_LEARNING_GATE_STATE_DIR;
  t.after(() => {
    if (previousState === undefined) delete process.env.AGENT_LEARNING_GATE_STATE_DIR;
    else process.env.AGENT_LEARNING_GATE_STATE_DIR = previousState;
  });
  const target = path.join(root, "AGENTS.md");
  const { handlers } = setupExtension();
  stageProposal(proposal(target), {
    projectDir: root,
    host: "pi",
    environment: env,
    sessionId: "pi-session",
  });
  const event = { toolName: "write", input: { path: target, content: "Use uv run pytest.\n" } };
  const base = {
    cwd: root,
    signal: undefined,
    sessionManager: { getSessionId: () => "pi-session" },
    ui: { setStatus() {}, select: async (_title, options) => options[1] },
  };
  assert.equal((await handlers.get("tool_call")(event, { ...base, hasUI: false })).block, true);
  assert.equal(
    await handlers.get("tool_call")(
      { toolName: "write", input: { ...event.input } },
      { ...base, hasUI: true },
    ),
    undefined,
  );
});

test("Pi denial consumes the permit and a session mismatch cannot approve", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-learning-gate-pi-deny-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previousState = process.env.AGENT_LEARNING_GATE_STATE_DIR;
  process.env.AGENT_LEARNING_GATE_STATE_DIR = path.join(root, ".state");
  t.after(() => {
    if (previousState === undefined) delete process.env.AGENT_LEARNING_GATE_STATE_DIR;
    else process.env.AGENT_LEARNING_GATE_STATE_DIR = previousState;
  });
  const target = path.join(root, "AGENTS.md");
  const { handlers } = setupExtension();
  stageProposal(proposal(target), {
    projectDir: root,
    host: "pi",
    environment: process.env,
    sessionId: "pi-session",
  });
  const event = () => ({
    toolName: "write",
    input: { path: target, content: "Use uv run pytest.\n" },
  });
  const context = (session, answer) => ({
    cwd: root,
    hasUI: true,
    signal: undefined,
    sessionManager: { getSessionId: () => session },
    ui: { setStatus() {}, select: async () => answer },
  });
  assert.equal((await handlers.get("tool_call")(event(), context("wrong", "Allow once"))).block, true);
  assert.equal((await handlers.get("tool_call")(event(), context("pi-session", "Deny"))).block, true);
  assert.equal(
    (await handlers.get("tool_call")(event(), context("pi-session", "Allow once"))).block,
    true,
  );
});

test("Pi blocks multi-edit and canonical protected symlink aliases", async (t) => {
  if (process.platform === "win32") return t.skip("requires file-symlink privileges");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-learning-gate-pi-symlink-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "AGENTS.md");
  const alias = path.join(root, "notes.md");
  fs.writeFileSync(target, "rule\n");
  fs.symlinkSync(target, alias);
  const { handlers } = setupExtension();
  const context = {
    cwd: root,
    hasUI: true,
    sessionManager: { getSessionId: () => "pi-session" },
    ui: { setStatus() {}, select: async () => "Allow once" },
  };
  const multi = await handlers.get("tool_call")(
    {
      toolName: "edit",
      input: {
        path: alias,
        edits: [
          { oldText: "rule", newText: "one" },
          { oldText: "one", newText: "two" },
        ],
      },
    },
    context,
  );
  assert.equal(multi.block, true);
  const write = await handlers.get("tool_call")(
    { toolName: "write", input: { path: alias, content: "bypass\n" } },
    context,
  );
  assert.equal(write.block, true);
});

test("Pi blocks when the target changes during its approval UI", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-learning-gate-pi-race-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previousState = process.env.AGENT_LEARNING_GATE_STATE_DIR;
  process.env.AGENT_LEARNING_GATE_STATE_DIR = path.join(root, ".state");
  t.after(() => {
    if (previousState === undefined) delete process.env.AGENT_LEARNING_GATE_STATE_DIR;
    else process.env.AGENT_LEARNING_GATE_STATE_DIR = previousState;
  });
  const target = path.join(root, "AGENTS.md");
  const { handlers } = setupExtension();
  stageProposal(proposal(target), {
    projectDir: root,
    host: "pi",
    environment: process.env,
    sessionId: "pi-session",
  });
  const result = await handlers.get("tool_call")(
    { toolName: "write", input: { path: target, content: "Use uv run pytest.\n" } },
    {
      cwd: root,
      hasUI: true,
      sessionManager: { getSessionId: () => "pi-session" },
      ui: {
        setStatus() {},
        select: async () => {
          fs.writeFileSync(target, "Concurrent change.\n");
          return "Allow once";
        },
      },
    },
  );
  assert.equal(result.block, true);
  assert.match(result.reason, /changed while confirmation/i);
});

test("Pi normalizes its @ path prefix before protected-path checks", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-learning-gate-pi-at-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { handlers } = setupExtension();
  const result = await handlers.get("tool_call")(
    { toolName: "write", input: { path: "@AGENTS.md", content: "bypass\n" } },
    {
      cwd: root,
      hasUI: true,
      sessionManager: { getSessionId: () => "pi-session" },
      ui: { setStatus() {}, select: async () => "Allow once" },
    },
  );
  assert.equal(result.block, true);
});

test("Pi normalizes file URLs and Unicode spaces like the built-in tools", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-learning-gate-pi-path-parity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { handlers } = setupExtension();
  const context = {
    cwd: root,
    hasUI: true,
    sessionManager: { getSessionId: () => "pi-session" },
    ui: { setStatus() {}, select: async () => "Allow once" },
  };
  const fileUrl = await handlers.get("tool_call")(
    {
      toolName: "write",
      input: { path: pathToFileURL(path.join(root, "AGENTS.md")).href, content: "bypass\n" },
    },
    context,
  );
  assert.equal(fileUrl.block, true);

  const custom = path.join(root, "policy file.txt");
  const previousExtra = process.env.AGENT_LEARNING_GATE_EXTRA_DESTINATIONS;
  process.env.AGENT_LEARNING_GATE_EXTRA_DESTINATIONS = JSON.stringify([
    { path: custom, target: "policy", scope: "workspace" },
  ]);
  t.after(() => {
    if (previousExtra === undefined) delete process.env.AGENT_LEARNING_GATE_EXTRA_DESTINATIONS;
    else process.env.AGENT_LEARNING_GATE_EXTRA_DESTINATIONS = previousExtra;
  });
  const unicodeSpace = await handlers.get("tool_call")(
    {
      toolName: "write",
      input: { path: "policy\u00a0file.txt", content: "bypass\n" },
    },
    context,
  );
  assert.equal(unicodeSpace.block, true);
});

test("Pi rejects a symlink retargeted while its UI is open", async (t) => {
  if (process.platform === "win32") return t.skip("requires file-symlink privileges");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-learning-gate-pi-retarget-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previousState = process.env.AGENT_LEARNING_GATE_STATE_DIR;
  process.env.AGENT_LEARNING_GATE_STATE_DIR = path.join(root, ".state");
  t.after(() => {
    if (previousState === undefined) delete process.env.AGENT_LEARNING_GATE_STATE_DIR;
    else process.env.AGENT_LEARNING_GATE_STATE_DIR = previousState;
  });
  const first = path.join(root, "AGENTS.md");
  const second = path.join(root, "CLAUDE.md");
  const alias = path.join(root, "notes.md");
  fs.writeFileSync(first, "");
  fs.writeFileSync(second, "");
  fs.symlinkSync(first, alias);
  const document = proposal(first);
  stageProposal(document, {
    projectDir: root,
    host: "pi",
    environment: process.env,
    sessionId: "pi-session",
  });
  const { handlers } = setupExtension();
  const result = await handlers.get("tool_call")(
    { toolName: "write", input: { path: alias, content: "Use uv run pytest.\n" } },
    {
      cwd: root,
      hasUI: true,
      sessionManager: { getSessionId: () => "pi-session" },
      ui: {
        setStatus() {},
        select: async () => {
          fs.unlinkSync(alias);
          fs.symlinkSync(second, alias);
          return "Allow once";
        },
      },
    },
  );
  assert.equal(result.block, true);
  assert.match(result.reason, /symlink changed/i);
});
