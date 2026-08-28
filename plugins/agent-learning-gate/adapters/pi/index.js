import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isProtectedLearningPath } from "../../lib/hook.mjs";
import {
  configuredDestinations,
  consumeMatchingPermit,
  projectStateRoot,
} from "../../lib/permits.mjs";
import { canonicalizeTargetPath, sha256 } from "../../lib/utils.mjs";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function canonicalPiPath(rawPath, cwd) {
  let value = String(rawPath || "").replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
  if (value.startsWith("@")) value = value.slice(1);
  if (value === "~") value = process.env.HOME || os.homedir();
  else if (value.startsWith("~/")) {
    value = path.join(process.env.HOME || os.homedir(), value.slice(2));
  }
  if (/^file:\/\//.test(value)) {
    try {
      value = fileURLToPath(value);
    } catch {
      // Leave malformed URLs for the normal path classifier to reject.
    }
  }
  if (process.platform === "win32" && /^\/(?:mnt\/|cygdrive\/)?[a-z](?:\/|$)/i.test(value)) {
    const match = value.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (match) value = `${match[1].toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") || ""}`;
  }
  return canonicalizeTargetPath(value, cwd);
}

function operationFromPi(event, cwd) {
  const rawPath = String(event.input?.path || "");
  if (event.toolName === "write") {
    return {
      tool: "Write",
      adapter: "pi",
      file_path: canonicalPiPath(rawPath, cwd),
      raw_file_path: rawPath,
      content: event.input?.content ?? null,
    };
  }
  if (event.toolName === "edit") {
    const edits = Array.isArray(event.input?.edits) ? event.input.edits : [];
    if (edits.length !== 1) {
      return {
        adapter: "pi",
        raw_file_path: rawPath,
        file_path: canonicalPiPath(rawPath, cwd),
        unsupported: "Pi Agent Learning Gate v0 requires one exact edit.",
      };
    }
    return {
      tool: "Edit",
      adapter: "pi",
      file_path: canonicalPiPath(rawPath, cwd),
      raw_file_path: rawPath,
      old_string: edits[0]?.oldText ?? null,
      new_string: edits[0]?.newText ?? null,
      replace_all: false,
    };
  }
  return null;
}

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function safePreview(operation) {
  const source = operation.tool === "Write"
    ? String(operation.content || "")
    : `${String(operation.old_string || "")}\n→\n${String(operation.new_string || "")}`;
  return source
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u001B]/g, "")
    .slice(0, 500);
}

export default function agentLearningGatePiExtension(pi) {
  pi.on("session_start", (_event, ctx) => {
    process.env.AGENT_LEARNING_GATE_SESSION_ID = ctx.sessionManager.getSessionId();
    process.env.AGENT_LEARNING_GATE_CLI = path.join(extensionRoot, "bin", "agent-learning-gate");
    if (ctx.hasUI) ctx.ui.setStatus("agent-learning-gate", "agent-learning-gate: active");
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!new Set(["write", "edit"]).has(String(event.toolName).toLowerCase())) return;
    const operation = operationFromPi(event, ctx.cwd || process.cwd());
    const projectDir = ctx.cwd || process.cwd();
    if (!operation?.raw_file_path) {
      return {
        block: true,
        reason: "Agent Learning Gate rejected a mutating Pi event with no decodable target path.",
      };
    }
    const piRoot = process.env.PI_CODING_AGENT_DIR;
    const extraPaths = [
      projectStateRoot(projectDir, process.env),
      ...configuredDestinations(process.env).map((entry) => entry.path),
      ...(piRoot
        ? [
            path.join(piRoot, "SYSTEM.md"),
            path.join(piRoot, "APPEND_SYSTEM.md"),
            path.join(piRoot, "skills"),
          ]
        : []),
    ];
    const protectedPath = [
      operation?.raw_file_path || event.input?.path,
      operation?.file_path,
    ].some((candidate) => isProtectedLearningPath(candidate, { extraPaths }));
    if (!protectedPath) return;
    if (operation?.unsupported) return { block: true, reason: operation.unsupported };
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: "Agent Learning Gate requires Pi TUI/RPC confirmation; print/json mode cannot approve durable writes.",
      };
    }

    const consumed = consumeMatchingPermit(operation, {
      projectDir,
      sessionId: ctx.sessionManager.getSessionId(),
      host: "pi",
      environment: process.env,
    });
    if (!consumed.matched) {
      return {
        block: true,
        reason:
          "Agent Learning Gate blocked an unapproved durable write. Run the bundled checker and stage the exact Pi Write/Edit first.",
      };
    }

    const displayPath = String(operation.file_path).replace(
      /[\u0000-\u001F\u007F\u001B]/g,
      "",
    );
    const digest = consumed.permit.operation_hash.slice(0, 12);
    let choice;
    try {
      choice = await ctx.ui.select(
        `Agent Learning Gate ${operation.tool} ${displayPath}\n${safePreview(operation)}\nsha256:${digest}`,
        ["Deny", "Allow once"],
        { timeout: 30_000, signal: ctx.signal },
      );
    } catch {
      return { block: true, reason: "Durable write confirmation failed or timed out." };
    }
    if (choice !== "Allow once") {
      return { block: true, reason: "Durable write denied by the user." };
    }
    if (canonicalPiPath(operation.raw_file_path, projectDir) !== operation.file_path) {
      return { block: true, reason: "Target symlink changed while confirmation was open; restage." };
    }
    const currentDigest = fs.existsSync(operation.file_path)
      ? sha256(fs.readFileSync(operation.file_path))
      : "missing";
    if (currentDigest !== consumed.permit.preimage_sha256) {
      return { block: true, reason: "Target changed while confirmation was open; restage." };
    }
    freezeDeep(event.input);
    try {
      Object.defineProperty(event, "input", {
        value: event.input,
        writable: false,
        configurable: false,
      });
      Object.freeze(event);
    } catch {
      return { block: true, reason: "Could not freeze the approved Pi tool input." };
    }
  });

  pi.registerCommand("agent-learning-gate", {
    description: "Show the Agent Learning Gate CLI and active adapter path",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Agent Learning Gate CLI: ${path.join(extensionRoot, "bin", "agent-learning-gate")}`, "info");
    },
  });
}
