#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FEEDBACK_PATTERN =
  /(?:做得不错|不错|很好|挺好|太好了|就是这样|可以了|好[，, ]|不对|不是|别|不要|不用|没必要|冗余|太长|太短|以后|记住|注意|只看|只分析|looks? good|nice work|great|perfect|exactly|wrong|not what|don't|do not|never|remember|from now on|too long|too short)/iu;

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function walk(root) {
  if (!root || !fs.existsSync(root)) return [];
  const output = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) stack.push(path.join(current, name));
    } else if (current.endsWith(".jsonl")) {
      output.push(current);
    }
  }
  return output.sort();
}

function textBlocks(content) {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter((item) => item && typeof item === "object" && typeof item.text === "string")
    .map((item) => item.text);
}

function codexUserMessage(record) {
  if (
    record?.type !== "response_item" ||
    record?.payload?.type !== "message" ||
    record?.payload?.role !== "user"
  ) {
    return null;
  }
  return textBlocks(record.payload.content).join("\n").trim();
}

function piUserMessage(record) {
  if (record?.type !== "message" || record?.message?.role !== "user") return null;
  return textBlocks(record.message.content).join("\n").trim();
}

function isInternalContext(text) {
  const value = text.trim();
  return (
    value.startsWith("<codex_internal_context") ||
    value.startsWith("<environment_context") ||
    value.startsWith("<recommended_plugins") ||
    value.startsWith("<app-context") ||
    value.includes("MEMORY_SUMMARY BEGINS")
  );
}

export function redact(text) {
  return String(text)
    // Conversation snippets can contain short source fragments with secrets or
    // proprietary code too. Redact every fenced block, not only long ones.
    .replace(/```[\s\S]*?```/g, "<CODE_BLOCK>")
    .replace(/```[\s\S]*$/g, "<CODE_BLOCK>")
    // Common provider, SCM and collaboration-service credentials.
    .replace(/\bsk-(?:proj|ant)-[A-Za-z0-9_-]{8,}\b/g, "<SECRET>")
    .replace(/\b(?:sk|pk|rk)_[A-Za-z0-9_-]{12,}\b/g, "<SECRET>")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g, "<SECRET>")
    .replace(/\bxox[a-z]-[A-Za-z0-9-]{10,}\b/gi, "<SECRET>")
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, "<SECRET>")
    // JWTs are three base64url segments. Require a JSON-looking first segment
    // to avoid replacing ordinary dotted identifiers.
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, "<SECRET>")
    .replace(/\b(Authorization\s*:\s*Bearer\s+)[^\s,;]+/gi, "$1<SECRET>")
    .replace(
      /\b([A-Za-z][A-Za-z0-9_]*(?:TOKEN|SECRET|API_KEY|PASSWORD)\s*=\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s#;]+)/gi,
      "$1<SECRET>",
    )
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "<EMAIL>")
    .replace(/https?:\/\/[^\s)\]>]+/g, "<URL>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<ID>")
    // Quoted paths may contain spaces; consume through the matching quote
    // before applying the conservative whitespace-delimited fallback below.
    .replace(/(["'])(\/(?:Users|Volumes|private|home|root|tmp|var)(?:\/[^"'\r\n]*)?)\1/g, "<PATH>")
    // Unquoted paths with spaces are ambiguous. Prefer over-redaction until a
    // clear conjunction or delimiter rather than leaking the trailing path.
    .replace(
      /\/(?:Users|Volumes|private|home|root|tmp|var)(?:\/[^\r\n,;]*?)(?=\s+(?:and|or|plus|以及|或者)\s+|[,;\r\n]|$)/giu,
      "<PATH>",
    )
    .replace(/\/(?:Users|Volumes|private|home|root|tmp|var)(?:\/[^\s'"`]+)?/g, "<PATH>")
    .replace(/[A-Z]:\\[^\s'"`]+/g, "<PATH>")
    .trim();
}

export function candidateKind(text) {
  // Corrections dominate praise. "Nice work, but this is wrong" must never
  // become a positive reward candidate merely because praise appears first.
  const hasDirectCorrection =
    /(?:不对|不是|别|不要|不用|没必要|冗余|太长|太短|wrong|not what|don't|do not|never|too long|too short)/iu.test(
      text,
    );
  const hasMixedCorrection =
    /(?:但是?|不过|然而)[^。！？.!?\n]{0,80}(?:改|调整|修|删|去掉|换成|应该|需要|只(?:要|看|保留))/u.test(
      text,
    ) ||
    /\b(?:but|however)\b[^.!?\n]{0,100}\b(?:change|fix|revise|remove|replace|instead|should|need|only)\b/iu.test(
      text,
    );
  if (hasDirectCorrection || hasMixedCorrection) {
    return "negative_or_correction_candidate";
  }
  if (
    text.length <= 180 &&
    /(?:做得不错|不错|很好|挺好|太好了|就是这样|looks? good|nice work|great|perfect|exactly)/iu.test(text)
  ) {
    return "positive_candidate";
  }
  if (/(?:以后|记住|注意|只看|只分析|remember|from now on)/iu.test(text)) {
    return "preference_or_scope_candidate";
  }
  return "feedback_candidate";
}

function extractFile(filePath, sourceKind) {
  const output = [];
  const sourceHash = sha256(filePath).slice(0, 16);
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const message = sourceKind === "codex" ? codexUserMessage(record) : piUserMessage(record);
    if (!message || isInternalContext(message) || !FEEDBACK_PATTERN.test(message)) continue;
    const sanitized = redact(message);
    if (!sanitized || sanitized.length > 650) continue;
    output.push({
      candidate_id: sha256(`${sourceKind}\0${filePath}\0${index}\0${sanitized}`).slice(0, 20),
      source_kind: sourceKind,
      source_file_hash: sourceHash,
      source_line: index + 1,
      timestamp: record.timestamp || record.message?.timestamp || null,
      candidate_kind: candidateKind(sanitized),
      text: sanitized,
    });
  }
  return output;
}

function main() {
  const codexRoot = path.resolve(
    arg("--codex-root", path.join(os.homedir(), ".codex", "sessions")),
  );
  const piRoot = path.resolve(
    arg("--pi-root", path.join(os.homedir(), ".omp", "agent", "sessions")),
  );
  const outputPath = path.resolve(
    arg("--output", path.join(process.cwd(), ".agent-learning-gate", "local-feedback-candidates.jsonl")),
  );
  const limit = Number(arg("--limit", "500"));

  const candidates = [
    ...walk(codexRoot).flatMap((filePath) => extractFile(filePath, "codex")),
    ...walk(piRoot).flatMap((filePath) => extractFile(filePath, "pi")),
  ].sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));

  const seenText = new Set();
  const deduplicated = [];
  for (const candidate of candidates) {
    const key = sha256(candidate.text.normalize("NFKC").replace(/\s+/g, " ").trim());
    if (seenText.has(key)) continue;
    seenText.add(key);
    deduplicated.push(candidate);
    if (deduplicated.length >= Math.max(1, limit)) break;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    outputPath,
    deduplicated.map((entry) => JSON.stringify(entry)).join("\n") +
      (deduplicated.length ? "\n" : ""),
    { mode: 0o600 },
  );

  const summary = deduplicated.reduce(
    (accumulator, entry) => {
      accumulator[entry.candidate_kind] = (accumulator[entry.candidate_kind] || 0) + 1;
      return accumulator;
    },
    {},
  );
  process.stdout.write(
    `${JSON.stringify({ output: outputPath, candidates: deduplicated.length, by_kind: summary }, null, 2)}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
