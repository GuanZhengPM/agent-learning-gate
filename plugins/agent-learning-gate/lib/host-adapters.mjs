import path from "node:path";

import {
  isProtectedBashWrite,
  isProtectedLearningContainerPath,
  isProtectedLearningPath,
} from "./hook.mjs";
import {
  configuredDestinations,
  projectStateRoot,
} from "./permits.mjs";
import { parseCodexPatch } from "./patch.mjs";
import { canonicalizeTargetPath, redactHome } from "./utils.mjs";

function projectDirFor(host, hookInput, environment) {
  if (host === "cursor") {
    return (
      hookInput?.workspace_roots?.[0] ||
      hookInput?.cwd ||
      environment.CURSOR_PROJECT_DIR ||
      environment.PWD ||
      process.cwd()
    );
  }
  return (
    hookInput?.cwd ||
    environment.CLAUDE_PROJECT_DIR ||
    environment.PWD ||
    process.cwd()
  );
}

function hookEventName(hookInput) {
  return String(hookInput?.hook_event_name || hookInput?.hookEventName || "");
}

function hookToolName(hookInput) {
  return String(hookInput?.tool_name || hookInput?.toolName || "");
}

function hookToolInput(hookInput) {
  const value = hookInput?.tool_input ?? hookInput?.toolInput;
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function cursorRawPath(hookInput) {
  const input = hookToolInput(hookInput);
  return input?.file_path || input?.filePath || input?.path || input?.target_path || input?.targetPath || "";
}

function pathIsInside(candidate, root) {
  const relative = path.relative(canonicalizeTargetPath(root), canonicalizeTargetPath(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function cursorRoots(hookInput, environment) {
  return [
    ...(Array.isArray(hookInput?.workspace_roots) ? hookInput.workspace_roots : []),
    ...(Array.isArray(hookInput?.workspaceRoots) ? hookInput.workspaceRoots : []),
    hookInput?.cwd,
    environment.CURSOR_PROJECT_DIR,
  ].filter((value, index, values) => value && values.indexOf(value) === index);
}

function cursorProjectForOperation(hookInput, environment) {
  const rawPath = cursorRawPath(hookInput);
  if (rawPath) {
    const absolute = canonicalizeTargetPath(rawPath, hookInput?.cwd || process.cwd());
    const matched = cursorRoots(hookInput, environment).find((root) => pathIsInside(absolute, root));
    if (matched) return matched;
  }
  return projectDirFor("cursor", hookInput, environment);
}

function extraPaths(environment, projectDir) {
  return [
    ...configuredDestinations(environment).map((entry) => entry.path),
    projectStateRoot(projectDir, environment),
  ];
}

function operationIsProtected(operation, projectDir, environment) {
  let rawPath = operation.raw_file_path || operation.file_path;
  if (String(operation.tool).toLowerCase() === "apply_patch") {
    rawPath = parseCodexPatch(operation.command).file_path;
  }
  const canonical = canonicalizeTargetPath(rawPath, projectDir);
  return [rawPath, canonical].some((candidate) =>
    isProtectedLearningPath(candidate, { extraPaths: extraPaths(environment, projectDir) }),
  );
}

function codexPatchTargets(command) {
  const source = String(command || "").replace(/\r\n/g, "\n");
  const lines = source.split("\n");
  const begin = lines.indexOf("*** Begin Patch");
  const end = lines.lastIndexOf("*** End Patch");
  if (begin < 0 || end <= begin) throw new Error("missing Begin/End Patch markers");
  if (
    lines.slice(0, begin).some((line) => line.trim()) ||
    lines.slice(end + 1).some((line) => line.trim())
  ) {
    throw new Error("data outside Begin/End Patch markers");
  }
  const targets = [];
  for (let index = begin + 1; index < end; index += 1) {
    const match = lines[index].match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/u);
    if (match) targets.push(match[1].trim());
    const move = lines[index].match(/^\*\*\* Move to: (.+)$/u);
    if (move) targets.push(move[1].trim());
  }
  if (targets.length === 0 || targets.some((target) => !target || target.includes("\0"))) {
    throw new Error("missing or invalid patch target");
  }
  return targets;
}

function codexPatchCommand(hookInput) {
  const raw = hookInput?.tool_input ?? hookInput?.toolInput;
  if (typeof raw === "string") return raw;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  const candidate = raw.command ?? raw.patch ?? raw.input;
  return typeof candidate === "string" ? candidate : "";
}

function deny(reason, details = {}) {
  return { action: "deny", reason, details };
}

export function evaluateCodexHook(hookInput, environment = process.env) {
  const projectDir = projectDirFor("codex", hookInput, environment);
  const eventName = hookEventName(hookInput);
  if (!eventName) return deny("Agent Learning Gate rejected a malformed Codex Hook event.");
  if (eventName === "UserPromptSubmit") {
    return { action: "continue_prompt" };
  }
  if (eventName !== "PreToolUse") return { action: "allow" };

  const toolName = hookToolName(hookInput).toLowerCase();
  if (!toolName) return deny("Agent Learning Gate rejected a Codex PreToolUse event with no tool name.");
  if (toolName === "bash") {
    const input = hookToolInput(hookInput);
    const command = typeof input?.command === "string" ? input.command : "";
    if (!command) return deny("Agent Learning Gate rejected a malformed Codex shell event.");
    return isProtectedBashWrite(command)
      ? deny("Agent Learning Gate blocked a shell write to durable agent configuration.")
      : { action: "allow" };
  }
  if (toolName !== "apply_patch") return { action: "allow" };
  const command = codexPatchCommand(hookInput);
  if (!command) return deny("Agent Learning Gate rejected an apply_patch event with no decodable patch.");
  let targets;
  try {
    targets = codexPatchTargets(command);
  } catch (error) {
    return deny(`Agent Learning Gate rejected an undecodable apply_patch event: ${error.message}.`);
  }
  let protectedWrite;
  try {
    const configured = extraPaths(environment, projectDir);
    protectedWrite = targets.some((candidate) => {
      const canonical = canonicalizeTargetPath(candidate, projectDir);
      return [candidate, canonical].some((value) =>
        isProtectedLearningPath(value, { extraPaths: configured }),
      );
    });
  } catch (error) {
    return deny(`Agent Learning Gate could not classify this apply_patch event: ${error.message}`);
  }
  if (!protectedWrite) return { action: "allow" };

  return deny(
    "Agent Learning Gate blocked this durable apply_patch. The Codex v0 adapter is deny-only: there is no Agent Learning Gate approve command or Agent retry path. Present the evidence-backed proposal, review receipt, and exact diff, then leave application to the user outside the Agent.",
  );
}

export function renderCodexHook(result, eventName) {
  if (result.action === "allow" || result.action === "continue_prompt") return null;
  if (eventName === "UserPromptSubmit") {
    return { decision: "block", reason: result.reason };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: result.reason,
    },
  };
}

function cursorOperation(hookInput, projectDir) {
  const toolName = hookToolName(hookInput);
  const toolInput = hookToolInput(hookInput) || {};
  if (toolName.toLowerCase() === "shell") {
    return { tool: "Bash", command: String(toolInput.command || ""), file_path: "" };
  }
  if (toolName.toLowerCase() === "delete") {
    const raw = String(cursorRawPath(hookInput));
    return {
      tool: "Delete",
      raw_file_path: raw,
      file_path: canonicalizeTargetPath(raw, projectDir),
    };
  }
  const raw = String(cursorRawPath(hookInput));
  return {
    tool: toolName,
    raw_file_path: raw,
    file_path: canonicalizeTargetPath(raw, projectDir),
    content: toolInput.content ?? null,
    old_string: toolInput.old_string ?? toolInput.oldString ?? null,
    new_string: toolInput.new_string ?? toolInput.newString ?? null,
    replace_all: Boolean(toolInput.replace_all ?? toolInput.replaceAll),
  };
}

export function evaluateCursorHook(hookInput, environment = process.env) {
  const eventName = hookEventName(hookInput);
  if (!eventName) return deny("Agent Learning Gate rejected a malformed Cursor Hook event.");
  if (["beforeSubmitPrompt", "UserPromptSubmit"].includes(eventName)) {
    return { action: "continue_prompt" };
  }
  const projectDir = cursorProjectForOperation(hookInput, environment);
  if (eventName === "beforeShellExecution") {
    const input = hookToolInput(hookInput);
    const command = String(hookInput?.command || input?.command || "");
    if (!command) return deny("Agent Learning Gate rejected a malformed Cursor shell event.");
    if (isProtectedBashWrite(command)) {
      return deny(
        "Agent Learning Gate blocks durable state writes through Shell on the Cursor v0 adapter.",
      );
    }
    return { action: "allow" };
  }
  if (!new Set(["preToolUse", "PreToolUse"]).has(eventName)) return { action: "allow" };
  const toolName = hookToolName(hookInput).toLowerCase();
  if (!toolName) return deny("Agent Learning Gate rejected a Cursor preToolUse event with no tool name.");
  if (!new Set(["write", "edit", "delete"]).has(toolName)) return { action: "allow" };
  if (!cursorRawPath(hookInput)) {
    return deny("Agent Learning Gate rejected a mutating Cursor event with no decodable target path.");
  }
  const operation = cursorOperation(hookInput, projectDir);
  let protectedWrite = false;
  try {
    protectedWrite = toolName === "delete"
      ? [operation.raw_file_path, operation.file_path].some((candidate) =>
          isProtectedLearningContainerPath(candidate, {
            extraPaths: extraPaths(environment, projectDir),
          }) ||
          isProtectedLearningPath(candidate, {
            extraPaths: extraPaths(environment, projectDir),
          }),
        )
      : operationIsProtected(operation, projectDir, environment);
  } catch (error) {
    return deny(`Agent Learning Gate could not classify this durable operation: ${error.message}`);
  }
  if (!protectedWrite) return { action: "allow" };
  if (String(operation.tool).toLowerCase() === "delete") {
    return deny("Agent Learning Gate does not authorize deletion of durable agent configuration.");
  }
  return deny(
    `Agent Learning Gate blocked an unapproved durable write to ${redactHome(operation.file_path)}. ` +
      "The Cursor v0 adapter is deny-only: there is no Agent Learning Gate approve command or Agent retry path. Present the proposal, review receipt, and exact diff, then leave application to the user outside the Agent.",
  );
}

export function renderCursorHook(result, eventName) {
  if (["beforeSubmitPrompt", "UserPromptSubmit"].includes(eventName)) {
    if (result.action === "reject_prompt") {
      return { continue: false, user_message: result.reason };
    }
    return { continue: true };
  }
  if (result.action === "deny") {
    return {
      permission: "deny",
      user_message: result.reason,
      agent_message: result.reason,
    };
  }
  return { permission: "allow" };
}

export function runHostHookProcess({ evaluate, render }) {
  let source = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    source += chunk;
  });
  process.stdin.on("end", () => {
    try {
      const input = JSON.parse(source || "{}");
      const result = evaluate(input, process.env);
      const output = render(result, input?.hook_event_name);
      if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
    } catch (error) {
      const output = render(deny(`Agent Learning Gate hook failed closed: ${error.message}`), "PreToolUse");
      if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
    }
  });
}
