import path from "node:path";

import {
  configuredDestinations,
  consumeMatchingPermit,
  projectStateRoot,
} from "./permits.mjs";
import { canonicalizeTargetPath, redactHome } from "./utils.mjs";

function slash(value) {
  return String(value || "").replaceAll("\\", "/");
}

function pathForComparison(value) {
  const normalized = slash(value).normalize("NFKC");
  const insensitive =
    process.platform === "win32" ||
    (process.platform === "darwin" && process.env.AGENT_LEARNING_GATE_CASE_SENSITIVE !== "1");
  return insensitive ? normalized.toLowerCase() : normalized;
}

export function isProtectedLearningPath(filePath, { extraPaths = [] } = {}) {
  const normalized = pathForComparison(filePath);
  if (!normalized) return false;
  const basename = path.basename(normalized);
  const claudeName = pathForComparison("CLAUDE.md");
  const claudeLocalName = pathForComparison("CLAUDE.local.md");
  const agentsName = pathForComparison("AGENTS.md");
  const agentsOverrideName = pathForComparison("AGENTS.override.md");
  const agentName = pathForComparison("AGENT.md");
  const piSystemName = pathForComparison("SYSTEM.md");
  const piAppendSystemName = pathForComparison("APPEND_SYSTEM.md");
  const skillName = pathForComparison("SKILL.md");
  if (
    basename === claudeName ||
    basename === claudeLocalName ||
    basename === agentsName ||
    basename === agentsOverrideName ||
    basename === agentName
  ) {
    return true;
  }
  if (normalized.includes("/.claude/rules/")) return true;
  if (normalized.includes("/.cursor/rules/")) return true;
  if (basename === pathForComparison(".cursorrules")) return true;
  if (normalized.includes("/.claude/skills/") && basename === skillName) return true;
  if (normalized.includes("/.agents/skills/") && basename === skillName) return true;
  if (normalized.includes("/.cursor/skills/") && basename === skillName) return true;
  if (normalized.includes("/.codex/skills/") && basename === skillName) return true;
  if (normalized.includes("/.pi/skills/") && basename === skillName) return true;
  if (normalized.includes("/.claude/projects/") && normalized.includes("/memory/")) return true;
  if (normalized.includes("/.claude/agent-memory/")) return true;
  if (normalized.includes("/.agent-learning-gate/")) return true;
  if (
    (basename === piSystemName || basename === piAppendSystemName) &&
    normalized.includes("/.pi/")
  ) {
    return true;
  }
  return extraPaths.some((candidate) => {
    const expanded = pathForComparison(candidate);
    return expanded && (normalized === expanded || normalized.startsWith(`${expanded}/`));
  });
}

export function isProtectedLearningContainerPath(filePath, { extraPaths = [] } = {}) {
  const normalized = pathForComparison(filePath).replace(/\/+$/u, "");
  if (!normalized) return false;
  const containerSegments = [
    "/.claude/rules",
    "/.claude/skills",
    "/.claude/agent-memory",
    "/.cursor/rules",
    "/.cursor/skills",
    "/.agents/skills",
    "/.codex/skills",
    "/.pi/skills",
    "/.agent-learning-gate",
  ];
  if (
    containerSegments.some((segment) =>
      normalized.endsWith(segment) || normalized.includes(`${segment}/`),
    )
  ) {
    return true;
  }
  if (normalized.includes("/.claude/projects/") && normalized.includes("/memory")) {
    return true;
  }
  return extraPaths.some((candidate) => {
    const expanded = pathForComparison(candidate).replace(/\/+$/u, "");
    return expanded && (normalized === expanded || normalized.startsWith(`${expanded}/`));
  });
}

export function operationFromHookInput(hookInput, projectDir) {
  const toolName = String(hookInput?.tool_name || hookInput?.toolName || "");
  const rawInput = hookInput?.tool_input ?? hookInput?.toolInput;
  const toolInput = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
    ? rawInput
    : {};
  if (toolName.toLowerCase() === "bash") {
    return {
      tool: toolName,
      file_path: "",
      command: String(toolInput.command || ""),
    };
  }
  if (toolName.toLowerCase() === "apply_patch") {
    return {
      tool: "apply_patch",
      file_path: "",
      raw_file_path: "",
      command: String(toolInput.command || ""),
      adapter: "codex",
    };
  }
  const filePath = canonicalizeTargetPath(
    toolInput.file_path || toolInput.filePath || toolInput.path || toolInput.target_path || toolInput.targetPath,
    projectDir,
  );
  return {
    tool: toolName,
    file_path: filePath,
    raw_file_path: String(
      toolInput.file_path || toolInput.filePath || toolInput.path || toolInput.target_path || toolInput.targetPath || "",
    ),
    content: toolInput.content ?? null,
    old_string: toolInput.old_string ?? toolInput.oldString ?? null,
    new_string: toolInput.new_string ?? toolInput.newString ?? null,
    replace_all: Boolean(toolInput.replace_all ?? toolInput.replaceAll),
  };
}

export function isProtectedBashWrite(command) {
  const normalized = slash(command).toLowerCase();
  if (!normalized) return false;
  const namesProtectedTarget =
    /(^|[\s'"/])claude(?:\.local)?\.md([\s'"/>]|$)/.test(normalized) ||
    /(^|[\s'"/])agents?\.md([\s'"/>]|$)/.test(normalized) ||
    /(^|[\s'"./])\.claude\/rules\//.test(normalized) ||
    /(^|[\s'"./])\.claude\/skills\//.test(normalized) ||
    /(^|[\s'"./])\.agents\/skills\//.test(normalized) ||
    /(^|[\s'"./])\.cursor\/rules\//.test(normalized) ||
    /(^|[\s'"./])\.cursor\/skills\//.test(normalized) ||
    /(^|[\s'"./])\.codex\/skills\//.test(normalized) ||
    /(^|[\s'"./])\.pi\/skills\//.test(normalized) ||
    /(^|[\s'"/])\.cursorrules([\s'">/]|$)/.test(normalized) ||
    /(^|[\s'"./])\.pi\/(?:system|append_system)\.md([\s'">/]|$)/.test(normalized) ||
    /(^|[\s'"./])\.agent-learning-gate\//.test(normalized) ||
    (/(^|[\s'"./])\.claude\/projects\//.test(normalized) &&
      normalized.includes("/memory/"));
  const performsWrite =
    /(^|\s)(tee|cp|mv|rm|truncate|install)(\s|$)/.test(normalized) ||
    /(^|\s)(sed\s+-[^\s]*i|perl\s+-[^\s]*i)/.test(normalized) ||
    /(^|[^<])>>?/.test(normalized);
  return namesProtectedTarget && performsWrite;
}

function extraProtectedPaths(environment, projectDir) {
  return [
    ...configuredDestinations(environment).map((entry) => entry.path),
    projectStateRoot(projectDir, environment),
  ];
}

export function evaluateHook(hookInput, environment = process.env) {
  const projectDir =
    environment.CLAUDE_PROJECT_DIR || hookInput?.cwd || environment.PWD || process.cwd();
  const operation = operationFromHookInput(hookInput, projectDir);
  const tool = String(operation.tool).toLowerCase();
  if (!tool) {
    return {
      action: "deny",
      protected: true,
      operation,
      reason: "Agent Learning Gate rejected a malformed matched Hook event with no tool name.",
      details: { reason: "malformed_hook_event" },
    };
  }
  if (new Set(["write", "edit"]).has(tool) && !operation.raw_file_path) {
    return {
      action: "deny",
      protected: true,
      operation,
      reason: "Agent Learning Gate rejected a mutating Hook event with no decodable target path.",
      details: { reason: "missing_target_path" },
    };
  }
  if (tool === "bash") {
    if (!isProtectedBashWrite(operation.command)) {
      return { action: "allow", protected: false, operation };
    }
    return {
      action: "deny",
      protected: true,
      operation,
      reason:
        "Agent Learning Gate blocked a shell-based write to durable Claude learning state. " +
        "Use the agent-learning-gate proposal workflow and an exact Write or Edit operation; Bash permits are intentionally unsupported.",
      details: { reason: "bash_write_bypass" },
    };
  }
  if (
    ![
      operation.raw_file_path,
      operation.file_path,
    ].some((candidate) =>
      isProtectedLearningPath(candidate, {
        extraPaths: extraProtectedPaths(environment, projectDir),
      }),
    )
  ) {
    return { action: "allow", protected: false, operation };
  }

  const consumed = consumeMatchingPermit(operation, {
    projectDir,
    sessionId: hookInput?.session_id || null,
    host: "claude-code",
    environment,
  });
  if (consumed.matched) {
    return {
      action: "ask",
      protected: true,
      operation,
      permit_id: consumed.permit.permit_id,
      reason:
        "Agent Learning Gate validated the proposal. Confirm this exact durable-learning write; the staged request is one-use and has now been consumed.",
    };
  }

  return {
    action: "deny",
    protected: true,
    operation,
    reason:
      `Agent Learning Gate blocked an unapproved durable-learning write to ${redactHome(operation.file_path)}. ` +
      "Create an evidence-backed proposal with /agent-learning-gate:agent-learning-gate, run agent-learning-gate check, then agent-learning-gate stage and retry the exact Write/Edit once; Claude Code will ask the user natively.",
    details: consumed,
  };
}

export function runHookProcess({ stdin = process.stdin, stderr = process.stderr } = {}) {
  let source = "";
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk) => {
    source += chunk;
  });
  stdin.on("end", () => {
    try {
      const hookInput = JSON.parse(source || "{}");
      const result = evaluateHook(hookInput);
      if (result.action === "deny" || result.action === "ask") {
        process.stdout.write(
          `${JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: result.action,
              permissionDecisionReason: result.reason,
            },
          })}\n`,
        );
      }
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `Agent Learning Gate hook failed closed: ${error.message}`,
          },
        })}\n`,
      );
    }
  });
}
