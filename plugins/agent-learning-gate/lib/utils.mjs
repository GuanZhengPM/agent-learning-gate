import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, " ")
    .trim();
}

export function normalizePath(value, baseDir = process.cwd()) {
  if (!value) return "";
  const expanded = String(value).startsWith("~/")
    ? path.join(process.env.HOME || "", String(value).slice(2))
    : String(value);
  return path.resolve(baseDir, expanded);
}

export function canonicalizeTargetPath(value, baseDir = process.cwd()) {
  const normalized = normalizePath(value, baseDir);
  if (!normalized) return "";
  try {
    return fs.realpathSync.native(normalized);
  } catch {
    const missing = [];
    let existing = normalized;
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) return normalized;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
    try {
      return path.join(fs.realpathSync.native(existing), ...missing);
    } catch {
      return normalized;
    }
  }
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

export function sha256(value) {
  const input = Buffer.isBuffer(value) ? value : String(value);
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function operationFingerprint(operation, baseDir = process.cwd()) {
  const tool = String(operation?.tool || operation?.tool_name || "").toLowerCase();
  const filePath = canonicalizeTargetPath(
    operation?.file_path || operation?.path || operation?.target_path,
    baseDir,
  );
  const normalized = {
    tool,
    file_path: filePath,
    content: operation?.content ?? null,
    old_string: operation?.old_string ?? null,
    new_string: operation?.new_string ?? null,
    replace_all: Boolean(operation?.replace_all),
    command: operation?.command ?? null,
    adapter: tool === "apply_patch" ? operation?.adapter ?? null : null,
  };
  return sha256(stableStringify(normalized));
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJsonAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, filePath);
}

export function redactHome(filePath) {
  const home = process.env.HOME;
  if (home && filePath.startsWith(`${home}${path.sep}`)) {
    return `~${filePath.slice(home.length)}`;
  }
  return filePath;
}

export function parseJsonLines(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  return source
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line && !line.startsWith("#"))
    .map(({ line, number }) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at ${filePath}:${number}: ${error.message}`);
      }
    });
}
