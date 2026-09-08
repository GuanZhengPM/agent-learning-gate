import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { ensurePrivateStateRoot, projectStateRoot } from "./permits.mjs";
import { readJson, sha256, writeJsonAtomic } from "./utils.mjs";

// Decision ledger: an append-only, human-readable record of options that were
// rejected, attempts that failed, and boundaries the user set. It exists because
// agent-authored handoff material (compaction summaries, memory files, subagent
// reports) systematically records progress and plans while dropping negative
// decisions, which lets the next session revive work that was already ruled out.
//
// The ledger is opt-in per project: the hooks are inert until DECISIONS.md exists
// (or AGENT_LEARNING_GATE_LEDGER=on). Hooks inject active entries at session start
// and, once per session that did work, refuse to stop until the agent either
// appends entries or explicitly records that there is nothing to add.

export const LEDGER_FILENAME = "DECISIONS.md";
export const LEDGER_KINDS = Object.freeze(["rejected", "failed", "veto", "constraint", "superseded"]);
export const LEDGER_SOURCES = Object.freeze(["user", "tool", "agent"]);
const LEDGER_VERSION = 1;
const DEFAULT_INJECT_LIMIT = 40;

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LEDGER_CLI_PATH = path.join(pluginRoot, "bin", "agent-learning-gate");

const HEADER = `# Decision ledger

Append-only record of rejected options, failed attempts, user vetoes, and
boundaries for this project. Managed by \`agent-learning-gate ledger\`.
Do not delete or edit entries; add a \`superseded\` entry to retire one.

<!-- agent-learning-gate ledger v${LEDGER_VERSION} -->
`;

function isTruthyFlag(value) {
  return ["1", "on", "true", "yes"].includes(String(value || "").trim().toLowerCase());
}

function isFalsyFlag(value) {
  return ["0", "off", "false", "no"].includes(String(value || "").trim().toLowerCase());
}

export function ledgerPath(projectDir, environment = process.env) {
  const override = environment.AGENT_LEARNING_GATE_LEDGER_FILE;
  if (override) return path.resolve(projectDir, override);
  return path.join(projectDir, LEDGER_FILENAME);
}

export function ledgerEnabled(projectDir, environment = process.env) {
  const flag = environment.AGENT_LEARNING_GATE_LEDGER;
  if (isFalsyFlag(flag)) return false;
  if (isTruthyFlag(flag)) return true;
  return fs.existsSync(ledgerPath(projectDir, environment));
}

export function enforcementEnabled(environment = process.env) {
  return !isFalsyFlag(environment.AGENT_LEARNING_GATE_LEDGER_ENFORCE);
}

function normalizeTitle(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function singleLine(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseLedger(text) {
  const entries = [];
  const source = String(text ?? "").replace(/\r\n/g, "\n");
  const blocks = source.split(/\n(?=## )/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const heading = lines[0] || "";
    const match = heading.match(/^## \[([a-z]+)\]\s*(.+?)\s*$/u);
    if (!match) continue;
    const [, kind, title] = match;
    if (!LEDGER_KINDS.includes(kind)) continue;
    const fields = {};
    for (const line of lines.slice(1)) {
      const field = line.match(/^- ([a-z_]+):\s*(.*)$/u);
      if (field) fields[field[1]] = field[2].trim();
    }
    entries.push({ kind, title: title.trim(), fields });
  }
  return entries;
}

export function activeEntries(entries) {
  const retired = new Set();
  for (const entry of entries) {
    if (entry.kind === "superseded" && entry.fields.supersedes) {
      retired.add(normalizeTitle(entry.fields.supersedes));
    }
  }
  return entries.filter(
    (entry) => entry.kind !== "superseded" && !retired.has(normalizeTitle(entry.title)),
  );
}

export function readLedger(projectDir, environment = process.env) {
  const filePath = ledgerPath(projectDir, environment);
  if (!fs.existsSync(filePath)) {
    return { path: filePath, exists: false, text: "", entries: [], digest: null };
  }
  const text = fs.readFileSync(filePath, "utf8");
  return { path: filePath, exists: true, text, entries: parseLedger(text), digest: sha256(text) };
}

export function initLedger(projectDir, environment = process.env) {
  const filePath = ledgerPath(projectDir, environment);
  if (fs.existsSync(filePath)) return { path: filePath, created: false };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, HEADER, "utf8");
  return { path: filePath, created: true };
}

export function formatEntry(entry) {
  const lines = [`## [${entry.kind}] ${singleLine(entry.title)}`];
  const order = ["when", "why", "source", "session", "host", "supersedes"];
  for (const key of order) {
    if (entry.fields[key]) lines.push(`- ${key}: ${singleLine(entry.fields[key])}`);
  }
  return `${lines.join("\n")}\n`;
}

export function appendEntry(
  projectDir,
  { kind, title, why, source, session, host, supersedes, when },
  environment = process.env,
) {
  if (!LEDGER_KINDS.includes(kind)) {
    throw new Error(`Unsupported ledger kind '${kind}'. Use one of: ${LEDGER_KINDS.join(", ")}.`);
  }
  if (!singleLine(title)) throw new Error("A ledger entry requires --title.");
  if (kind !== "superseded" && !singleLine(why)) {
    throw new Error("A ledger entry requires --why (the reason it was ruled out).");
  }
  if (kind === "superseded" && !singleLine(supersedes)) {
    throw new Error("A superseded entry requires --supersedes <title of the retired entry>.");
  }
  if (source && !LEDGER_SOURCES.includes(source)) {
    throw new Error(`Unsupported --source '${source}'. Use one of: ${LEDGER_SOURCES.join(", ")}.`);
  }
  initLedger(projectDir, environment);
  const filePath = ledgerPath(projectDir, environment);
  const entry = {
    kind,
    title: singleLine(title),
    fields: {
      when: when || new Date().toISOString(),
      why: singleLine(why),
      source: source || "agent",
      session: singleLine(session),
      host: singleLine(host),
      supersedes: singleLine(supersedes),
    },
  };
  const existing = fs.readFileSync(filePath, "utf8");
  const separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  fs.appendFileSync(filePath, `${separator}${formatEntry(entry)}`, "utf8");
  return { path: filePath, entry };
}

export function renderLedgerContext(entries, { limit = DEFAULT_INJECT_LIMIT, cliPath = LEDGER_CLI_PATH } = {}) {
  const active = activeEntries(entries);
  if (active.length === 0) return "";
  const shown = active.slice(-limit);
  const omitted = active.length - shown.length;
  const lines = [
    "[Agent Learning Gate decision ledger] The following decisions were settled in earlier sessions of this project. Treat them as binding unless the user explicitly reopens one. Do not re-propose, retry, or silently work around them; if a new request conflicts with an entry, say so and ask before proceeding.",
  ];
  for (const entry of shown) {
    const why = entry.fields.why ? ` (${entry.fields.why})` : "";
    const source = entry.fields.source ? ` [${entry.fields.source}]` : "";
    lines.push(`- ${entry.kind}: ${entry.title}${why}${source}`);
  }
  if (omitted > 0) lines.push(`- ... ${omitted} older entries omitted; read ${LEDGER_FILENAME} for the full list.`);
  lines.push(
    `To record a new rejected option, failed attempt, or user boundary: ${cliPath} ledger add --kind rejected|failed|veto|constraint --title "..." --why "..." --source user|tool|agent`,
  );
  return lines.join("\n");
}

function noneMarkerPath(projectDir, environment) {
  return path.join(projectStateRoot(projectDir, environment), "ledger-none.json");
}

export function recordNone(projectDir, reason, environment = process.env) {
  ensurePrivateStateRoot(projectDir, environment);
  const marker = { at: new Date().toISOString(), reason: singleLine(reason) };
  writeJsonAtomic(noneMarkerPath(projectDir, environment), marker);
  return marker;
}

function readNoneMarker(projectDir, environment) {
  const filePath = noneMarkerPath(projectDir, environment);
  if (!fs.existsSync(filePath)) return null;
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

function sessionStatePath(projectDir, sessionId, environment) {
  const safe = String(sessionId || "unknown").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return path.join(projectStateRoot(projectDir, environment), "ledger-sessions", `${safe}.json`);
}

export function loadSessionState(projectDir, sessionId, environment = process.env) {
  const filePath = sessionStatePath(projectDir, sessionId, environment);
  if (!fs.existsSync(filePath)) return null;
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

export function saveSessionState(projectDir, sessionId, state, environment = process.env) {
  ensurePrivateStateRoot(projectDir, environment);
  const filePath = sessionStatePath(projectDir, sessionId, environment);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeJsonAtomic(filePath, state);
  return filePath;
}

const CLAUDE_EVENTS = {
  SessionStart: "session_start",
  UserPromptSubmit: "prompt",
  PostToolUse: "tool",
  Stop: "stop",
};

const CODEX_EVENTS = CLAUDE_EVENTS;

const CURSOR_EVENTS = {
  sessionStart: "session_start",
  beforeSubmitPrompt: "prompt",
  afterFileEdit: "tool",
  afterShellExecution: "tool",
  stop: "stop",
};

export function normalizeHookInput(hookInput, host, environment = process.env) {
  const input = hookInput || {};
  const eventName = String(input.hook_event_name || "");
  const table = host === "cursor" ? CURSOR_EVENTS : host === "codex" ? CODEX_EVENTS : CLAUDE_EVENTS;
  const projectDir =
    environment.CLAUDE_PROJECT_DIR ||
    environment.CURSOR_PROJECT_DIR ||
    (Array.isArray(input.workspace_roots) && input.workspace_roots[0]) ||
    input.cwd ||
    process.cwd();
  return {
    host,
    eventName,
    event: table[eventName] || "other",
    sessionId: input.session_id || input.conversation_id || "unknown",
    projectDir: path.resolve(projectDir),
    stopActive: Boolean(input.stop_hook_active) || Number(input.loop_count || 0) > 0,
    source: input.source || null,
  };
}

function stopReason(projectDir, cliPath) {
  const cli = `${cliPath} ledger`;
  return [
    "Agent Learning Gate decision ledger: this session changed files or ran commands, but DECISIONS.md was not updated.",
    "Before finishing, record every option that was rejected, attempt that failed, or boundary the user set during this session. One command per item:",
    `  ${cli} add --project-dir "${projectDir}" --kind rejected|failed|veto|constraint --title "<short name of the option or boundary>" --why "<why it was ruled out>" --source user|tool|agent`,
    "Use --source user when the user said it, tool when a command or test showed it, agent when you concluded it.",
    "If nothing of that kind happened in this session, run instead:",
    `  ${cli} none --project-dir "${projectDir}" --reason "<one sentence>"`,
    "Then finish your final message.",
  ].join("\n");
}

export function evaluateLedgerHook(hookInput, host, environment = process.env, { cliPath = LEDGER_CLI_PATH, now = () => new Date() } = {}) {
  const normalized = normalizeHookInput(hookInput, host, environment);
  const { projectDir, sessionId, event } = normalized;
  if (event === "other") return { action: "none", normalized };
  if (!ledgerEnabled(projectDir, environment)) return { action: "none", normalized };

  const ledger = readLedger(projectDir, environment);
  const state = loadSessionState(projectDir, sessionId, environment) || {
    version: LEDGER_VERSION,
    session_id: sessionId,
    host,
    started_at: now().toISOString(),
    ledger_digest_at_start: ledger.digest,
    injected_digest: null,
    did_work: false,
    blocked_once: false,
  };

  let result = { action: "none", normalized };

  if (event === "session_start" || event === "prompt") {
    const canInject = host !== "cursor" || event === "session_start";
    const changed = state.injected_digest !== ledger.digest;
    if (canInject && changed) {
      const context = renderLedgerContext(ledger.entries, { cliPath });
      if (context) {
        state.injected_digest = ledger.digest;
        result = { action: "inject", context, normalized };
      }
    }
  } else if (event === "tool") {
    state.did_work = true;
  } else if (event === "stop") {
    const noneMarker = readNoneMarker(projectDir, environment);
    const noneAfterStart = noneMarker && noneMarker.at >= state.started_at;
    const ledgerChanged = ledger.digest !== state.ledger_digest_at_start;
    const shouldBlock =
      enforcementEnabled(environment) &&
      state.did_work &&
      !ledgerChanged &&
      !noneAfterStart &&
      !state.blocked_once &&
      !normalized.stopActive;
    if (shouldBlock) {
      state.blocked_once = true;
      result = { action: "block", reason: stopReason(projectDir, cliPath), normalized };
    }
  }

  saveSessionState(projectDir, sessionId, state, environment);
  return result;
}

export function renderLedgerHook(result) {
  const { action, normalized } = result;
  if (action === "none") return null;
  const host = normalized.host;
  if (action === "inject") {
    if (host === "cursor") return { additional_context: result.context };
    return {
      hookSpecificOutput: {
        hookEventName: normalized.eventName,
        additionalContext: result.context,
      },
    };
  }
  if (action === "block") {
    if (host === "cursor") return { followup_message: result.reason };
    return { decision: "block", reason: result.reason };
  }
  return null;
}

export function runLedgerHookProcess(host, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  let source = "";
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk) => {
    source += chunk;
  });
  stdin.on("end", () => {
    try {
      const input = JSON.parse(source || "{}");
      const output = renderLedgerHook(evaluateLedgerHook(input, host));
      if (output) stdout.write(`${JSON.stringify(output)}\n`);
    } catch (error) {
      // The ledger is a cooperative aid, never a gate: fail open and stay silent.
      stderr.write(`agent-learning-gate ledger hook skipped: ${error.message}\n`);
    }
  });
}
