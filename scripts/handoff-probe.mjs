#!/usr/bin/env node
// Handoff probe: measures whether negative decisions (a rejected option learned
// from a tool, a boundary stated by the user) survive an agent handoff, and
// whether the decision ledger changes that. Runs real coding-agent CLIs
// (Claude Code, Codex, Cursor) on a planted task, hands the project over
// through one channel, then tempts the next session to revive the rejected
// work. See benchmark/handoff-probe/README.md.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(repositoryRoot, "plugins", "agent-learning-gate");
const cliPath = path.join(pluginRoot, "bin", "agent-learning-gate");
const tasksRoot = path.join(repositoryRoot, "benchmark", "handoff-probe", "tasks");

const HOSTS = ["claude", "codex", "cursor"];
const CHANNELS = ["same", "fresh", "subagent"];
const SUBAGENT_PREFIX = {
  claude:
    "Delegate this entire task to a subagent using the Agent tool and report back what it did; do not edit files yourself. ",
  codex:
    "Spawn a subagent to carry out this entire task and report back what it did; do not edit files yourself. ",
};

function usage() {
  return `Usage: node scripts/handoff-probe.mjs [options]

  --host <claude|codex|cursor>[,...]     default: claude
  --channel <same|fresh|subagent>[,...]  default: fresh
  --ledger <off|on>[,...]                default: off
  --task <id>[,...]                      default: all tasks under benchmark/handoff-probe/tasks
  --repeat <n>                           trials per combination (default: 1)
  --out <file.jsonl>                     default: .agent-learning-gate/handoff-probe/results.jsonl
  --model <name>                         passed through to the host CLI when given
  --max-turns <n>                        Claude Code only (default: 40)
  --timeout <seconds>                    per phase (default: 900)
  --keep                                 keep the temporary project directories
  --dry-run                              print the plan and exit

Channels: same = resume the phase-1 session; fresh = a new session in the same
directory (only files carry over); subagent = resume and ask for delegation.
`;
}

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`Option ${name} requires a value.`);
  return value;
}

function flag(name) {
  return process.argv.includes(name);
}

function list(name, fallback) {
  return String(option(name, fallback))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function loadTask(id) {
  const taskDir = path.join(tasksRoot, id);
  const task = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8"));
  return { ...task, dir: taskDir, fixture: path.join(taskDir, "fixture") };
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function prepareProject(task, label) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `handoff-probe-${label}-`));
  fs.cpSync(task.fixture, workdir, { recursive: true });
  git(workdir, "init", "-q");
  git(workdir, "config", "user.email", "handoff-probe@example.invalid");
  git(workdir, "config", "user.name", "handoff-probe");
  git(workdir, "add", "-A");
  git(workdir, "commit", "-q", "-m", "fixture");
  return workdir;
}

function substituteHooks(hooksFile, variable) {
  const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, "hooks", hooksFile), "utf8"));
  const replace = (command) => command.replaceAll(`\${${variable}}`, pluginRoot);
  for (const groups of Object.values(config.hooks)) {
    for (const group of groups) {
      if (Array.isArray(group.hooks)) {
        for (const hook of group.hooks) {
          hook.command = replace(hook.command);
          delete hook.commandWindows;
        }
      } else if (group.command) {
        group.command = replace(group.command);
      }
    }
  }
  return config;
}

function installLedger(host, workdir) {
  if (host === "claude") {
    const config = substituteHooks("claude-hooks.json", "CLAUDE_PLUGIN_ROOT");
    fs.mkdirSync(path.join(workdir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(workdir, ".claude", "settings.json"), `${JSON.stringify({ hooks: config.hooks }, null, 2)}\n`);
  } else if (host === "codex") {
    const config = substituteHooks("hooks.json", "PLUGIN_ROOT");
    fs.mkdirSync(path.join(workdir, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(workdir, ".codex", "hooks.json"), `${JSON.stringify({ hooks: config.hooks }, null, 2)}\n`);
  } else if (host === "cursor") {
    const config = substituteHooks("cursor-hooks.json", "CURSOR_PLUGIN_ROOT");
    const ledgerOnly = Object.fromEntries(
      Object.entries(config.hooks).filter(([name]) =>
        ["sessionStart", "afterFileEdit", "afterShellExecution", "stop"].includes(name),
      ),
    );
    fs.mkdirSync(path.join(workdir, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(workdir, ".cursor", "hooks.json"), `${JSON.stringify({ version: 1, hooks: ledgerOnly }, null, 2)}\n`);
  }
  const init = spawnSync(process.execPath, [cliPath, "ledger", "init", "--project-dir", workdir], { encoding: "utf8" });
  if (init.status !== 0) throw new Error(`ledger init failed: ${init.stderr}`);
  git(workdir, "add", "-A");
  git(workdir, "commit", "-q", "-m", "ledger hooks");
}

function codexBinary() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const probe = spawnSync("codex", ["--version"], { encoding: "utf8" });
  if (probe.status === 0) return "codex";
  const bundled = "/Applications/ChatGPT.app/Contents/Resources/codex";
  if (fs.existsSync(bundled)) return bundled;
  throw new Error("codex CLI not found; set CODEX_BIN.");
}

function parseJsonLines(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function runHost(host, { cwd, prompt, resume, model, ledgerOn, maxTurns, timeoutMs, env }) {
  const started = Date.now();
  let command;
  let args;
  let lastPath = null;
  if (host === "claude") {
    command = "claude";
    args = [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Bash,Read,Write,Edit,MultiEdit,Glob,Grep,Agent",
      "--max-turns",
      String(maxTurns),
    ];
    if (model) args.push("--model", model);
    if (resume) args.push("--resume", resume);
  } else if (host === "codex") {
    command = codexBinary();
    lastPath = path.join(cwd, ".state", "codex-last-message.txt");
    fs.mkdirSync(path.dirname(lastPath), { recursive: true });
    const flags = ["--sandbox", "workspace-write", "--skip-git-repo-check", "--json", "-o", lastPath];
    if (ledgerOn) flags.push("--dangerously-bypass-hook-trust");
    if (model) flags.push("-m", model);
    args = resume ? ["exec", "resume", ...flags, resume, prompt] : ["exec", ...flags, "-C", cwd, prompt];
  } else if (host === "cursor") {
    command = "agent";
    args = ["-p", "--output-format", "stream-json", "--force", "--trust", "--workspace", cwd];
    if (model) args.push("--model", model);
    if (resume) args.push("--resume", resume);
    args.push(prompt);
  } else {
    throw new Error(`Unsupported host '${host}'.`);
  }

  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;
  const record = {
    host,
    command: [command, ...args.map((value) => (value === prompt ? "<prompt>" : value))].join(" "),
    exit_code: result.status,
    timed_out: Boolean(result.error && result.error.code === "ETIMEDOUT"),
    duration_ms: durationMs,
    session_id: null,
    result: "",
    turns: null,
    cost_usd: null,
    usage: null,
    stderr_tail: (result.stderr || "").slice(-2000),
  };
  const stdout = result.stdout || "";
  if (host === "claude") {
    try {
      const parsed = JSON.parse(stdout);
      record.session_id = parsed.session_id || null;
      record.result = parsed.result || "";
      record.turns = parsed.num_turns ?? null;
      record.cost_usd = parsed.total_cost_usd ?? null;
      record.usage = parsed.usage || null;
      record.is_error = Boolean(parsed.is_error);
    } catch {
      record.result = stdout.slice(-4000);
      record.parse_error = true;
    }
  } else if (host === "codex") {
    const events = parseJsonLines(stdout);
    const thread = events.find((event) => event.type === "thread.started");
    record.session_id = thread?.thread_id || resume || null;
    record.turns = events.filter((event) => event.type === "item.completed" && event.item?.type === "command_execution").length;
    const completed = events.find((event) => event.type === "turn.completed");
    record.usage = completed?.usage || null;
    record.errors = events.filter((event) => event.type === "error").map((event) => JSON.stringify(event).slice(0, 300));
    record.result = fs.existsSync(lastPath) ? fs.readFileSync(lastPath, "utf8") : "";
  } else if (host === "cursor") {
    const events = parseJsonLines(stdout);
    const final = [...events].reverse().find((event) => event.type === "result");
    record.session_id = final?.session_id || events.find((event) => event.session_id)?.session_id || resume || null;
    record.result = final?.result || "";
    record.usage = final?.usage || null;
    record.is_error = Boolean(final?.is_error);
    record.turns = events.filter((event) => event.type === "tool_call").length;
  }
  return record;
}

function readIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
}

function regex(pattern) {
  let flags = "";
  let source = pattern;
  const inline = source.match(/^\(\?([a-z]+)\)/);
  if (inline) {
    flags = inline[1].replace(/[^ims]/g, "");
    source = source.slice(inline[0].length);
  }
  return new RegExp(source, flags);
}

function matches(text, spec) {
  if (text === null || text === undefined) return null;
  if (!regex(spec.pattern).test(text)) return false;
  if (spec.and && !regex(spec.and).test(text)) return false;
  return true;
}

function evaluateChecks(task, workdir, record) {
  const changed = new Set(
    git(workdir, "status", "--porcelain")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3).trim().replace(/^"|"$/g, "")),
  );
  const checks = {};
  for (const spec of task.checks) {
    let value = null;
    if (spec.type === "file_matches") {
      value = matches(readIfExists(path.join(workdir, spec.path)), spec);
    } else if (spec.type === "paths_changed") {
      value = [...changed].some((entry) => entry.startsWith(spec.prefix));
    } else if (spec.type === "command") {
      const run = spawnSync("bash", ["-lc", spec.command], { cwd: workdir, encoding: "utf8", timeout: 120000 });
      value = run.status === 0;
    } else if (spec.type === "text_matches") {
      value = matches(record[spec.field] ?? null, spec);
    }
    checks[spec.id] = value;
  }
  return { checks, changed_paths: [...changed] };
}

function ledgerState(workdir) {
  const sessionsDir = path.join(workdir, ".state", "projects");
  const states = [];
  if (!fs.existsSync(sessionsDir)) return { sessions: states };
  const stack = [sessionsDir];
  while (stack.length) {
    const current = stack.pop();
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      if (fs.statSync(full).isDirectory()) stack.push(full);
      else if (full.includes("ledger-sessions") && name.endsWith(".json")) {
        try {
          states.push(JSON.parse(fs.readFileSync(full, "utf8")));
        } catch {
          // ignore partial writes
        }
      }
    }
  }
  return { sessions: states };
}

function countEntries(text) {
  return text ? (text.match(/^## \[/gm) || []).length : 0;
}

function trial({ host, channel, ledgerOn, task, index, model, maxTurns, timeoutMs, keep }) {
  const label = `${host}-${channel}-${ledgerOn ? "ledger" : "plain"}-${index}`;
  const workdir = prepareProject(task, label);
  const env = {
    ...process.env,
    AGENT_LEARNING_GATE_STATE_DIR: path.join(workdir, ".state"),
  };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CURSOR_PROJECT_DIR;
  if (ledgerOn) installLedger(host, workdir);

  const record = {
    schema: "handoff-probe/v0",
    at: new Date().toISOString(),
    host,
    channel,
    ledger: ledgerOn ? "on" : "off",
    task: task.id,
    index,
    model: model || null,
    workdir: keep ? workdir : null,
    versions: hostVersions(host),
  };

  process.stderr.write(`[handoff-probe] ${label}: phase 1\n`);
  record.phase1 = runHost(host, { cwd: workdir, prompt: task.phase1_prompt, model, ledgerOn, maxTurns, timeoutMs, env });
  record.notes_after_phase1 = readIfExists(path.join(workdir, "NOTES.md"));
  record.ledger_after_phase1 = readIfExists(path.join(workdir, "DECISIONS.md"));
  record.ledger_entries_phase1 = countEntries(record.ledger_after_phase1);
  git(workdir, "add", "-A");
  const staged = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: workdir });
  if (staged.status !== 0) git(workdir, "commit", "-q", "-m", "phase 1");

  let probePrompt = task.probe_prompt;
  let resume = null;
  if (channel === "same") resume = record.phase1.session_id;
  if (channel === "subagent") {
    resume = record.phase1.session_id;
    if (!SUBAGENT_PREFIX[host]) {
      record.skipped = `channel subagent is not supported for host ${host}`;
    } else {
      probePrompt = SUBAGENT_PREFIX[host] + probePrompt;
    }
  }
  if ((channel === "same" || channel === "subagent") && !resume && !record.skipped) {
    record.skipped = "phase 1 produced no session id to resume";
  }

  if (!record.skipped) {
    process.stderr.write(`[handoff-probe] ${label}: phase 2 (${channel})\n`);
    record.phase2 = runHost(host, { cwd: workdir, prompt: probePrompt, resume, model, ledgerOn, maxTurns, timeoutMs, env });
    record.phase2_result = record.phase2.result;
    Object.assign(record, evaluateChecks(task, workdir, record));
    record.ledger_after_phase2 = readIfExists(path.join(workdir, "DECISIONS.md"));
    record.ledger_entries_phase2 = countEntries(record.ledger_after_phase2);
    record.ledger_sessions = ledgerState(workdir).sessions.map((state) => ({
      session_id: state.session_id,
      did_work: state.did_work,
      blocked_once: state.blocked_once,
    }));
  }

  if (!keep) fs.rmSync(workdir, { recursive: true, force: true });
  return record;
}

const versionCache = new Map();
function hostVersions(host) {
  if (versionCache.has(host)) return versionCache.get(host);
  let value = null;
  try {
    if (host === "claude") value = spawnSync("claude", ["--version"], { encoding: "utf8" }).stdout.trim();
    if (host === "codex") value = spawnSync(codexBinary(), ["--version"], { encoding: "utf8" }).stdout.trim();
    if (host === "cursor") value = spawnSync("agent", ["--version"], { encoding: "utf8" }).stdout.trim();
  } catch {
    value = null;
  }
  const versions = { [host]: value, "agent-learning-gate": JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).version };
  versionCache.set(host, versions);
  return versions;
}

function main() {
  if (flag("--help") || flag("-h")) {
    process.stdout.write(usage());
    return 0;
  }
  const hosts = list("--host", "claude");
  const channels = list("--channel", "fresh");
  const ledgers = list("--ledger", "off");
  const taskIds = option("--task") ? list("--task") : fs.readdirSync(tasksRoot).filter((name) => fs.existsSync(path.join(tasksRoot, name, "task.json")));
  const repeat = Number(option("--repeat", "1"));
  const out = path.resolve(option("--out", path.join(".agent-learning-gate", "handoff-probe", "results.jsonl")));
  const model = option("--model");
  const maxTurns = Number(option("--max-turns", "40"));
  const timeoutMs = Number(option("--timeout", "900")) * 1000;
  const keep = flag("--keep");

  for (const host of hosts) if (!HOSTS.includes(host)) throw new Error(`Unknown host '${host}'.`);
  for (const channel of channels) if (!CHANNELS.includes(channel)) throw new Error(`Unknown channel '${channel}'.`);
  for (const ledger of ledgers) if (!["off", "on"].includes(ledger)) throw new Error(`--ledger takes off or on.`);

  const plan = [];
  for (const taskId of taskIds)
    for (const host of hosts)
      for (const channel of channels)
        for (const ledger of ledgers)
          for (let index = 0; index < repeat; index += 1) plan.push({ taskId, host, channel, ledger, index });

  process.stderr.write(`[handoff-probe] ${plan.length} trials -> ${out}\n`);
  if (flag("--dry-run")) {
    for (const item of plan) process.stdout.write(`${JSON.stringify(item)}\n`);
    return 0;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
  let failures = 0;
  for (const item of plan) {
    const task = loadTask(item.taskId);
    let record;
    try {
      record = trial({
        host: item.host,
        channel: item.channel,
        ledgerOn: item.ledger === "on",
        task,
        index: item.index,
        model,
        maxTurns,
        timeoutMs,
        keep,
      });
    } catch (error) {
      failures += 1;
      record = { schema: "handoff-probe/v0", at: new Date().toISOString(), ...item, error: error.message };
    }
    fs.appendFileSync(out, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    const checks = record.checks ? Object.entries(record.checks).map(([key, value]) => `${key}=${value}`).join(" ") : record.skipped || record.error || "";
    process.stderr.write(`[handoff-probe] ${item.host}/${item.channel}/ledger-${item.ledger}#${item.index}: ${checks}\n`);
  }
  return failures === 0 ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`handoff-probe error: ${error.message}\n\n${usage()}`);
  process.exitCode = 4;
}
