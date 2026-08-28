import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DECISIONS,
  ERROR_CODES,
  SCOPE_COVERAGE,
  TARGET_ALIASES,
} from "./constants.mjs";
import {
  checkProposal,
  findPolarityReversal,
  hasReplacementCue,
} from "./engine.mjs";
import { materializeCodexPatch, parseCodexPatch } from "./patch.mjs";
import {
  canonicalizeTargetPath,
  operationFingerprint,
  readJson,
  sha256,
  stableStringify,
  writeJsonAtomic,
} from "./utils.mjs";

export const DEFAULT_PERMIT_TTL_MS = 5 * 60 * 1000;
export const ENGINE_VERSION = "0.2.0";

export function stateBaseRoot(environment = process.env) {
  const configuredRoot = environment.AGENT_LEARNING_GATE_STATE_DIR;
  return path.resolve(
    configuredRoot || path.join(environment.HOME || os.homedir(), ".agent-learning-gate"),
  );
}

export function projectStateRoot(projectDir, environment = process.env) {
  const root = stateBaseRoot(environment);
  const projectKey = sha256(canonicalizeTargetPath(projectDir)).slice(0, 20);
  return path.join(root, "projects", projectKey);
}

function normalizedText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\r\n/g, "\n")
    .replace(/\n+$/g, "");
}

function slash(value) {
  return String(value || "").replaceAll("\\", "/");
}

function isInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeTarget(target) {
  return TARGET_ALIASES[String(target || "").toLowerCase()] || null;
}

function expandHome(value, environment) {
  if (!String(value || "").startsWith("~/")) return String(value || "");
  return path.join(environment.HOME || os.homedir(), String(value).slice(2));
}

function claudeConfigRoot(environment) {
  return canonicalizeTargetPath(
    expandHome(
      environment.CLAUDE_CONFIG_DIR || path.join(environment.HOME || os.homedir(), ".claude"),
      environment,
    ),
  );
}

function claudePathHash(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

export function sanitizeClaudeProjectPath(projectPath) {
  const source = String(projectPath).normalize("NFC");
  const sanitized = source.replace(/[^A-Za-z0-9]/g, "-");
  if (sanitized.length <= 200) return sanitized;
  return `${sanitized.slice(0, 200)}-${claudePathHash(source)}`;
}

export function encodeClaudeProjectDirectory(projectDir) {
  const resolved = path.resolve(projectDir);
  let realProject = resolved;
  try {
    // Match Claude Code's project-root initialization. On Windows, the non-native
    // realpath form intentionally avoids the extended-length \\?\ prefix.
    realProject = fs.realpathSync(resolved);
  } catch {
    // Preserve deterministic behavior for a not-yet-created project directory.
  }
  return sanitizeClaudeProjectPath(realProject);
}

export function configuredDestinations(environment = process.env) {
  const destinations = [];
  const configRoot = claudeConfigRoot(environment);
  try {
    const settings = JSON.parse(
      fs.readFileSync(path.join(configRoot, "settings.json"), "utf8"),
    );
    if (settings.autoMemoryDirectory) {
      destinations.push({
        path: canonicalizeTargetPath(
          expandHome(settings.autoMemoryDirectory, environment),
        ),
        target: "memory",
        scope: "workspace",
      });
    }
  } catch {
    // Missing or invalid settings do not expand the writable surface.
  }
  const piRoot = canonicalizeTargetPath(
    environment.PI_CODING_AGENT_DIR ||
      path.join(environment.HOME || os.homedir(), ".pi", "agent"),
  );
  destinations.push(
    { path: path.join(piRoot, "SYSTEM.md"), target: "policy", scope: "global" },
    { path: path.join(piRoot, "APPEND_SYSTEM.md"), target: "policy", scope: "global" },
    { path: path.join(piRoot, "skills"), target: "skill", scope: "global" },
  );
  if (environment.AGENT_LEARNING_GATE_EXTRA_DESTINATIONS) {
    try {
      const extra = JSON.parse(environment.AGENT_LEARNING_GATE_EXTRA_DESTINATIONS);
      if (!Array.isArray(extra)) {
        throw new Error("AGENT_LEARNING_GATE_EXTRA_DESTINATIONS must be a JSON array.");
      }
      for (const entry of extra) {
        if (
          !entry ||
          typeof entry !== "object" ||
          Array.isArray(entry) ||
          typeof entry.path !== "string" ||
          !entry.path ||
          typeof entry.target !== "string" ||
          !Object.prototype.hasOwnProperty.call(TARGET_ALIASES, entry.target) ||
          !["workspace", "project", "global"].includes(entry.scope)
        ) {
          throw new Error(
            "Each AGENT_LEARNING_GATE_EXTRA_DESTINATIONS entry requires path, a supported target, and workspace/project/global scope.",
          );
        }
        destinations.push({
          path: canonicalizeTargetPath(expandHome(entry.path, environment)),
          target: normalizeTarget(entry.target),
          scope: entry.scope === "project" ? "workspace" : entry.scope,
        });
      }
    } catch (error) {
      throw new Error(`Invalid AGENT_LEARNING_GATE_EXTRA_DESTINATIONS: ${error.message}`);
    }
  }
  return destinations;
}

export function classifyOperationDestination(
  filePath,
  projectDir,
  environment = process.env,
) {
  if (!filePath) return null;
  const lexical = path.resolve(projectDir, filePath);
  const canonical = canonicalizeTargetPath(filePath, projectDir);
  const comparable = slash(lexical).toLowerCase();
  const basename = path.basename(comparable);
  const project = path.resolve(projectDir);
  const canonicalProject = canonicalizeTargetPath(project);
  const insideProject = isInside(lexical, project);
  const canonicalInsideProject = isInside(canonical, canonicalProject);
  if (insideProject !== canonicalInsideProject) {
    throw new Error(
      "Operation path crosses the workspace boundary through a symlink or alias.",
    );
  }
  const scope = insideProject ? "workspace" : "global";

  const configRoot = claudeConfigRoot(environment);
  const expectedProjectMemory = canonicalizeTargetPath(
    path.join(
      configRoot,
      "projects",
      encodeClaudeProjectDirectory(project),
      "memory",
    ),
  );
  if (isInside(canonical, expectedProjectMemory)) {
    return { target: "memory", scope: "workspace", lexical_path: lexical };
  }
  const allProjectMemories = canonicalizeTargetPath(path.join(configRoot, "projects"));
  if (
    isInside(canonical, allProjectMemories) &&
    slash(canonical).toLowerCase().includes("/memory/")
  ) {
    throw new Error("Operation targets Claude auto-memory for a different workspace.");
  }

  for (const configured of configuredDestinations(environment)) {
    if (isInside(canonical, configured.path)) {
      return {
        target: configured.target,
        scope: configured.scope,
        lexical_path: lexical,
      };
    }
  }

  if (
    [
      "claude.md", "claude.local.md", "agents.md", "agents.override.md", "agent.md",
      ".cursorrules",
    ].includes(basename)
  ) {
    return { target: "policy", scope, lexical_path: lexical };
  }
  if (comparable.includes("/.claude/rules/") || comparable.includes("/.cursor/rules/")) {
    return { target: "rule", scope, lexical_path: lexical };
  }
  if (
    (
      comparable.includes("/.claude/skills/") ||
      comparable.includes("/.agents/skills/") ||
      comparable.includes("/.cursor/skills/") ||
      comparable.includes("/.codex/skills/") ||
      comparable.includes("/.pi/skills/")
    ) &&
    basename === "skill.md"
  ) {
    return { target: "skill", scope, lexical_path: lexical };
  }
  if (comparable.includes("/.claude/agent-memory/")) {
    return { target: "memory", scope, lexical_path: lexical };
  }
  if (
    comparable.includes("/.pi/") &&
    ["system.md", "append_system.md"].includes(basename)
  ) {
    return { target: "policy", scope, lexical_path: lexical };
  }
  return null;
}

function operationPostimage(operation, targetPath) {
  const tool = String(operation?.tool || operation?.tool_name || "").toLowerCase();
  const current = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : "";
  if (tool === "write") return String(operation.content ?? "");
  if (tool !== "edit") throw new Error("Only Write and Edit operations are supported.");
  const oldString = String(operation.old_string ?? "");
  const newString = String(operation.new_string ?? "");
  if (!oldString) throw new Error("Edit operation old_string must be non-empty.");
  const occurrences = current.split(oldString).length - 1;
  if (occurrences === 0) throw new Error("Edit operation old_string does not match the target.");
  if (!operation.replace_all && occurrences !== 1) {
    throw new Error("Edit operation old_string must match exactly once unless replace_all is true.");
  }
  return operation.replace_all
    ? current.split(oldString).join(newString)
    : current.replace(oldString, newString);
}

function referencedReplacementArtifact(proposalDocument) {
  const proposal = proposalDocument.proposal || {};
  const references = new Set([
    ...(Array.isArray(proposal.supersedes) ? proposal.supersedes : []),
    ...(proposal.replaces ? [proposal.replaces] : []),
  ]);
  if (references.size === 0) return null;
  const proposalScope = proposal.scope === "project" ? "workspace" : proposal.scope;
  const scopesOverlap = (left, right) => {
    const a = left === "project" ? "workspace" : left;
    const b = right === "project" ? "workspace" : right;
    return (
      a === b ||
      (SCOPE_COVERAGE[a] || []).includes(b) ||
      (SCOPE_COVERAGE[b] || []).includes(a)
    );
  };
  return (Array.isArray(proposalDocument.current?.artifacts)
    ? proposalDocument.current.artifacts
    : []
  ).find((artifact) =>
    (references.has(artifact?.id) || references.has(artifact?.key)) &&
    ["active", "trial"].includes(artifact?.status) &&
    normalizeTarget(artifact?.target) === normalizeTarget(proposal.target) &&
    scopesOverlap(artifact?.scope, proposalScope),
  );
}

function semanticDelta(operation, targetPath, proposalDocument) {
  const tool = String(operation?.tool || operation?.tool_name || "").toLowerCase();
  const current = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : "";
  const postimage = operationPostimage(operation, targetPath);
  if (!current) return postimage;
  if (tool === "write" && postimage.startsWith(current)) return postimage.slice(current.length);
  if (tool === "edit") {
    const oldString = String(operation.old_string ?? "");
    const newString = String(operation.new_string ?? "");
    if (!operation.replace_all && newString.startsWith(oldString)) {
      return newString.slice(oldString.length);
    }
    const artifact = referencedReplacementArtifact(proposalDocument);
    if (!hasReplacementCue(proposalDocument.evidence) || !artifact) {
      throw new Error(
        "A replacement Edit requires explicit replacement language and a referenced current artifact.",
      );
    }
    if (operation.replace_all) {
      throw new Error("A reviewed replacement Edit must target one exact artifact, not replace_all.");
    }
    if (normalizedText(oldString) !== normalizedText(artifact.content ?? artifact.value)) {
      throw new Error(
        "Replacement old_string must exactly match the current artifact named by replaces/supersedes.",
      );
    }
    return newString;
  }
  return null;
}

export function operationTargetPath(operation, projectDir) {
  const tool = String(operation?.tool || operation?.tool_name || "").toLowerCase();
  const rawPath =
    tool === "apply_patch"
      ? parseCodexPatch(operation?.command).file_path
      : operation?.file_path || operation?.path || operation?.target_path;
  return canonicalizeTargetPath(rawPath, projectDir);
}

export function validateOperationBinding(
  proposalDocument,
  projectDir,
  environment = process.env,
) {
  const proposal = proposalDocument.proposal || {};
  const operation = proposal.operation;
  const operationTool = String(operation?.tool || "").toLowerCase();
  const parsedPatch = operationTool === "apply_patch" ? parseCodexPatch(operation.command) : null;
  const rawPath = parsedPatch?.file_path || operation?.file_path || operation?.path || operation?.target_path;
  const destination = classifyOperationDestination(rawPath, projectDir, environment);
  if (!destination) {
    throw new Error("Operation target is not a recognized durable-learning artifact.");
  }
  const proposalTarget = normalizeTarget(proposal.target);
  if (proposalTarget !== destination.target) {
    throw new Error(
      `Proposal target '${proposal.target}' does not match operation destination '${destination.target}'.`,
    );
  }
  const proposalScope = proposal.scope === "project" ? "workspace" : proposal.scope;
  const declaredInstallScope = proposal.install_scope === "project"
    ? "workspace"
    : proposal.install_scope;
  const installScope = declaredInstallScope ||
    (["workspace", "global"].includes(proposalScope) ? proposalScope : null);
  if (!installScope) {
    throw new Error(
      `Proposal scope '${proposal.scope}' requires explicit install_scope 'workspace' or 'global'.`,
    );
  }
  if (!["workspace", "global"].includes(installScope)) {
    throw new Error("install_scope must be 'workspace' or 'global'.");
  }
  if (installScope !== destination.scope) {
    throw new Error(
      `Proposal install_scope '${installScope}' does not match destination scope '${destination.scope}'.`,
    );
  }
  if (
    ["workspace", "global"].includes(proposalScope) &&
    proposalScope !== installScope
  ) {
    throw new Error(
      `Behavioral scope '${proposal.scope}' cannot be installed at broader or different scope '${installScope}'.`,
    );
  }

  const targetPath = canonicalizeTargetPath(rawPath, projectDir);
  const patchMaterialized = parsedPatch
    ? materializeCodexPatch(parsedPatch, targetPath)
    : null;
  const delta = patchMaterialized?.delta ?? semanticDelta(operation, targetPath, proposalDocument);
  if (delta === null || normalizedText(delta) !== normalizedText(proposal.content)) {
    throw new Error(
      "The exact content changed by proposal.operation must equal proposal.content and contain no unrelated mutation.",
    );
  }
  const replacement = !parsedPatch && Boolean(referencedReplacementArtifact(proposalDocument)) &&
    hasReplacementCue(proposalDocument.evidence) &&
    String(operation?.tool || "").toLowerCase() === "edit" &&
    !String(operation.new_string ?? "").startsWith(String(operation.old_string ?? ""));
  if (!replacement && fs.existsSync(targetPath)) {
    const current = fs.readFileSync(targetPath, "utf8");
    const reversal = findPolarityReversal(current, proposal.content);
    if (reversal) {
      throw new Error(
        `Proposal conflicts with trusted target contents and does not declare a reviewed replacement: ${JSON.stringify(reversal)}`,
      );
    }
  }
  return {
    destination,
    targetPath,
    delta,
    postimage: patchMaterialized?.postimage ?? operationPostimage(operation, targetPath),
    replacement,
  };
}

export function permitRoot(projectDir, environment = process.env) {
  return path.join(projectStateRoot(projectDir, environment), "permits");
}

export function reviewRoot(projectDir, environment = process.env) {
  return path.join(projectStateRoot(projectDir, environment), "reviews");
}

function ensureSafePermitRoot(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) {
      throw new Error(`Permit directory must not be a symlink: ${root}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Permit directory must be owned by the current user: ${root}`);
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    fs.chmodSync(root, 0o700);
    if ((fs.statSync(root).mode & 0o077) !== 0) {
      throw new Error(`Permit directory permissions are too broad: ${root}`);
    }
  }
}

export function ensurePrivateStateRoot(projectDir, environment = process.env) {
  const base = stateBaseRoot(environment);
  const projects = path.join(base, "projects");
  const project = projectStateRoot(projectDir, environment);
  for (const directory of [base, projects, project]) ensureSafePermitRoot(directory);
  return project;
}

function proposalDigest(proposalDocument) {
  const copy = structuredClone(proposalDocument);
  if (copy.user_confirmation) {
    delete copy.user_confirmation.confirmed_at;
  }
  return sha256(stableStringify(copy));
}

function fileDigest(filePath) {
  try {
    return sha256(fs.readFileSync(filePath));
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

const REVIEW_HOST_TOOLS = Object.freeze({
  "claude-code": new Set(["write", "edit"]),
  codex: new Set(["apply_patch"]),
  cursor: new Set(["write", "edit"]),
  pi: new Set(["write", "edit"]),
  generic: new Set(["write", "edit"]),
});

function operationMismatch(message, details = {}) {
  const error = new Error(message);
  error.result = {
    decision: DECISIONS.BLOCK,
    summary: message,
    issues: [
      { code: ERROR_CODES.OPERATION_MISMATCH, message, details },
    ],
  };
  return error;
}

export function reviewProposal(
  proposalDocument,
  {
    projectDir,
    environment = process.env,
    host = "generic",
  } = {},
) {
  if (!projectDir) throw new Error("projectDir is required to review an operation.");
  const result = checkProposal(proposalDocument);
  if (result.decision !== DECISIONS.PASS) {
    const error = new Error("Only a PASS proposal can be operation-reviewed.");
    error.result = result;
    throw error;
  }
  const operation = proposalDocument.proposal?.operation;
  const tool = String(operation?.tool || operation?.tool_name || "").toLowerCase();
  if (!operation || !["write", "edit", "apply_patch"].includes(tool)) {
    throw operationMismatch(
      "Operation review requires an exact Write, Edit, or apply_patch operation.",
      { allowed_tools: ["Write", "Edit", "apply_patch"] },
    );
  }
  if (!REVIEW_HOST_TOOLS[host] || !REVIEW_HOST_TOOLS[host].has(tool)) {
    throw operationMismatch(`Host '${host}' does not support reviewed tool '${operation.tool}'.`);
  }
  if (operation.adapter && operation.adapter !== host) {
    throw operationMismatch(
      `Operation adapter '${operation.adapter}' does not match review host '${host}'.`,
    );
  }
  const operationHash = operationFingerprint(operation, projectDir);
  const targetPath = operationTargetPath(operation, projectDir);
  if (!targetPath) throw operationMismatch("Operation file_path is required.");
  let binding;
  try {
    binding = validateOperationBinding(proposalDocument, projectDir, environment);
  } catch (bindingError) {
    throw operationMismatch(bindingError.message);
  }
  return {
    result,
    operation,
    tool,
    operationHash,
    targetPath,
    binding,
    preimageSha256: fileDigest(targetPath),
    postimageSha256: sha256(binding.postimage),
  };
}

function receiptDigest(receipt) {
  const payload = structuredClone(receipt);
  delete payload.receipt_digest;
  return sha256(stableStringify(payload));
}

export function recordReview(
  proposalDocument,
  {
    projectDir,
    environment = process.env,
    host = "generic",
    now = Date.now(),
  } = {},
) {
  const reviewed = reviewProposal(proposalDocument, { projectDir, environment, host });
  ensurePrivateStateRoot(projectDir, environment);
  const root = reviewRoot(projectDir, environment);
  ensureSafePermitRoot(root);
  const receiptId = crypto.randomUUID();
  const receipt = {
    schema_version: 1,
    kind: "agent_learning_gate_review_receipt",
    authorizes_write: false,
    receipt_id: receiptId,
    reviewed_at: new Date(now).toISOString(),
    engine_version: ENGINE_VERSION,
    host,
    project_dir: path.resolve(projectDir),
    target_path: reviewed.targetPath,
    target: reviewed.binding.destination.target,
    install_scope: reviewed.binding.destination.scope,
    operation_hash: reviewed.operationHash,
    preimage_sha256: reviewed.preimageSha256,
    postimage_sha256: reviewed.postimageSha256,
    proposal_digest: proposalDigest(proposalDocument),
    proposal_content: proposalDocument.proposal.content,
    validated_delta: reviewed.binding.delta,
    operation: reviewed.operation,
  };
  receipt.receipt_digest = receiptDigest(receipt);
  const receiptPath = path.join(root, `${receiptId}.json`);
  writeJsonAtomic(receiptPath, receipt);
  fs.chmodSync(receiptPath, 0o600);
  return { reviewed, receipt, receiptPath };
}

export function verifyReviewReceipt(receiptPath) {
  const absoluteReceiptPath = path.resolve(receiptPath);
  const stat = fs.lstatSync(absoluteReceiptPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Review receipt must be a regular file, not a symlink.");
  }
  const receipt = readJson(absoluteReceiptPath);
  if (
    receipt?.kind !== "agent_learning_gate_review_receipt" ||
    receipt?.authorizes_write !== false ||
    typeof receipt?.project_dir !== "string" ||
    typeof receipt?.target_path !== "string" ||
    typeof receipt?.operation_hash !== "string" ||
    typeof receipt?.preimage_sha256 !== "string" ||
    typeof receipt?.postimage_sha256 !== "string" ||
    typeof receipt?.receipt_digest !== "string" ||
    !receipt?.operation
  ) {
    throw new Error("Invalid Agent Learning Gate review receipt.");
  }
  if (receipt.receipt_digest !== receiptDigest(receipt)) {
    throw new Error("Review receipt integrity check failed.");
  }
  const targetPath = operationTargetPath(receipt.operation, receipt.project_dir);
  if (
    targetPath !== canonicalizeTargetPath(receipt.target_path, receipt.project_dir) ||
    receipt.operation_hash !== operationFingerprint(receipt.operation, receipt.project_dir)
  ) {
    throw new Error("Review receipt operation binding is inconsistent.");
  }
  const currentSha256 = fileDigest(targetPath);
  const status = currentSha256 === receipt.postimage_sha256
    ? "VERIFIED"
    : currentSha256 === receipt.preimage_sha256
      ? "NOT_APPLIED"
      : "DRIFTED";
  return {
    matched: status === "VERIFIED",
    status,
    receipt,
    receiptPath: absoluteReceiptPath,
    targetPath,
    currentSha256,
  };
}

export function stageProposal(
  proposalDocument,
  {
    projectDir,
    proposalFile = null,
    ttlMs = DEFAULT_PERMIT_TTL_MS,
    now = Date.now(),
    environment = process.env,
    host = "claude-code",
    sessionId =
      proposalDocument?.session_id ||
      environment.AGENT_LEARNING_GATE_SESSION_ID ||
      environment.CLAUDE_CODE_SESSION_ID ||
      null,
  } = {},
) {
  if (!["claude-code", "pi"].includes(host)) {
    throw operationMismatch(
      `Host '${host}' has no trusted v0 approval channel; review is available but staging is disabled.`,
    );
  }
  const reviewed = reviewProposal(proposalDocument, { projectDir, environment, host });
  const { operation, tool, operationHash, targetPath, binding } = reviewed;

  ensurePrivateStateRoot(projectDir, environment);
  const permitId = crypto.randomUUID();
  const baseRecord = {
    schema_version: 1,
    engine_version: ENGINE_VERSION,
    permit_id: permitId,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + Math.max(1_000, Number(ttlMs))).toISOString(),
    project_dir: path.resolve(projectDir),
    target_path: targetPath,
    tool,
    operation_hash: operationHash,
    preimage_sha256: reviewed.preimageSha256,
    postimage_sha256: reviewed.postimageSha256,
    proposal_digest: proposalDigest(proposalDocument),
    proposal_file: proposalFile ? path.resolve(proposalFile) : null,
    session_id: sessionId,
    operation,
    host,
    approval_mode: "native_prompt",
  };
  const root = permitRoot(projectDir, environment);
  ensureSafePermitRoot(root);
  const permit = {
    ...baseRecord,
    permission_decision: "ask",
  };
  const permitPath = path.join(root, `${permitId}.json`);
  writeJsonAtomic(permitPath, permit);
  fs.chmodSync(permitPath, 0o600);
  return { permit, permitPath };
}

export function pruneExpiredPermits(
  projectDir,
  now = Date.now(),
  environment = process.env,
) {
  const root = permitRoot(projectDir, environment);
  if (!fs.existsSync(root)) return [];
  const removed = [];
  for (const name of fs.readdirSync(root)) {
    if (!name.endsWith(".json")) continue;
    const filePath = path.join(root, name);
    try {
      const permit = readJson(filePath);
      if (Date.parse(permit.expires_at) <= now) {
        fs.unlinkSync(filePath);
        removed.push(filePath);
      }
    } catch {
      const quarantine = `${filePath}.invalid`;
      try {
        fs.renameSync(filePath, quarantine);
      } catch {
        // A concurrent hook may already have consumed it.
      }
    }
  }
  return removed;
}

export function consumeMatchingPermit(
  operation,
  {
    projectDir,
    now = Date.now(),
    sessionId = null,
    host = null,
    environment = process.env,
  } = {},
) {
  if (!projectDir) return { matched: false, reason: "missing_project_dir" };
  ensurePrivateStateRoot(projectDir, environment);
  pruneExpiredPermits(projectDir, now, environment);
  const root = permitRoot(projectDir, environment);
  if (!fs.existsSync(root)) return { matched: false, reason: "no_permit_directory" };

  const fingerprint = operationFingerprint(operation, projectDir);
  let targetPath;
  try {
    targetPath = operationTargetPath(operation, projectDir);
  } catch (error) {
    return { matched: false, reason: "invalid_operation", error: error.message };
  }
  const candidates = fs
    .readdirSync(root)
    .filter((name) => name.endsWith(".json"))
    .sort();

  for (const name of candidates) {
    const permitPath = path.join(root, name);
    const claimPath = `${permitPath}.claim`;
    let claimFd = null;
    try {
      // O_EXCL is the portable claim boundary. Renaming one source to different
      // destinations is not reliably single-winner across concurrent Windows processes.
      claimFd = fs.openSync(claimPath, "wx", 0o600);
    } catch {
      continue;
    }
    try {
      let permit;
      try {
        permit = readJson(permitPath);
      } catch {
        continue;
      }
      if (
        permit.operation_hash !== fingerprint ||
        canonicalizeTargetPath(permit.target_path, projectDir) !== targetPath ||
        (permit.session_id && permit.session_id !== sessionId) ||
        (host && permit.host !== host) ||
        permit.preimage_sha256 !== fileDigest(targetPath) ||
        Date.parse(permit.expires_at) <= now
      ) {
        continue;
      }

      const usedDirectory = path.join(root, "used");
      fs.mkdirSync(usedDirectory, { recursive: true, mode: 0o700 });
      const consumedPath = path.join(
        usedDirectory,
        `${path.basename(permitPath, ".json")}.${now}.used.json`,
      );
      try {
        fs.renameSync(permitPath, consumedPath);
        return { matched: true, permit, consumedPath };
      } catch {
        continue;
      }
    } finally {
      try {
        if (claimFd !== null) fs.closeSync(claimFd);
      } catch {
        // The claim file remains fail-closed until permit expiry if cleanup is interrupted.
      }
      try {
        fs.unlinkSync(claimPath);
      } catch {
        // Another same-account process may already have cleaned up the claim.
      }
    }
  }
  return { matched: false, reason: "no_matching_permit", targetPath, fingerprint };
}
