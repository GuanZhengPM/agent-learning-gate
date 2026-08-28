import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { DECISIONS, ERROR_CODES, EXIT_CODES } from "./constants.mjs";
import { hostCapability, HOST_CAPABILITIES } from "./capabilities.mjs";
import { checkProposal, formatResult } from "./engine.mjs";
import {
  ensurePrivateStateRoot,
  projectStateRoot,
  recordReview,
  stageProposal,
  verifyReviewReceipt,
} from "./permits.mjs";
import { parseJsonLines, readJson, redactHome } from "./utils.mjs";

function usage() {
  return `agent-learning-gate 0.2.0

Usage:
  agent-learning-gate check <proposal.json> [--format text|json]
  agent-learning-gate review <proposal.json> --project-dir <path> --host <host> [--format text|json]
  agent-learning-gate verify <review-receipt.json> [--format text|json]
  agent-learning-gate stage <proposal.json> --project-dir <path> --host claude-code|pi [--ttl-seconds 300]
  agent-learning-gate state-dir --project-dir <path>
  agent-learning-gate proposal-dir --project-dir <path>
  agent-learning-gate capabilities [claude-code|codex|cursor|pi|generic] [--format text|json]
  agent-learning-gate benchmark <cases.jsonl> [--format text|json]
  agent-learning-gate demo [--format text|json]
  agent-learning-gate version
`;
}

function option(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (index + 1 >= args.length) throw new Error(`Option ${name} requires a value.`);
  return args[index + 1];
}

function resultExitCode(result) {
  if (result.decision === DECISIONS.PASS) return EXIT_CODES.PASS;
  if (result.issues?.some((entry) => entry.code === ERROR_CODES.INVALID_INPUT)) {
    return EXIT_CODES.INVALID_INPUT;
  }
  if (result.decision === DECISIONS.ABSTAIN) return EXIT_CODES.ABSTAIN;
  return EXIT_CODES.BLOCK;
}

function demoDocument() {
  return {
    id: "demo-ambiguous-praise",
    evidence: {
      text: "做得不错",
      source_turn: "turn-104",
      kind: "implicit_praise",
      scope: "task",
      explicit_persistence: false,
    },
    current: { artifacts: [], active_scope: "project" },
    proposal: {
      target: "CLAUDE.md",
      content: "Always use tables in responses.",
      scope: "global",
      durability: "active",
    },
    user_confirmation: { confirmed: false },
  };
}

function runBenchmark(filePath, format) {
  const cases = parseJsonLines(filePath);
  const rows = [];
  for (const testCase of cases) {
    const document = Object.fromEntries(
      ["id", "session_id", "evidence", "current", "proposal", "user_confirmation"]
        .filter((key) => testCase[key] !== undefined)
        .map((key) => [key, testCase[key]]),
    );
    const result = checkProposal(document);
    const expectedCodes = new Set(testCase.expected_codes || []);
    const actualCodes = new Set(result.issues.map((entry) => entry.code));
    const missingCodes = [...expectedCodes].filter((code) => !actualCodes.has(code));
    const unexpectedCodes = [...actualCodes].filter((code) => !expectedCodes.has(code));
    const passed =
      result.decision === testCase.expected_decision &&
      missingCodes.length === 0 &&
      unexpectedCodes.length === 0;
    rows.push({
      id: testCase.id,
      passed,
      expected_decision: testCase.expected_decision,
      actual_decision: result.decision,
      expected_codes: [...expectedCodes],
      actual_codes: [...actualCodes],
      missing_codes: missingCodes,
      unexpected_codes: unexpectedCodes,
    });
  }
  const summary = {
    total: rows.length,
    passed: rows.filter((row) => row.passed).length,
    failed: rows.filter((row) => !row.passed).length,
    pass_rate: rows.length ? rows.filter((row) => row.passed).length / rows.length : 0,
    rows,
  };
  if (format === "json") return `${JSON.stringify(summary, null, 2)}\n`;
  const lines = [
    `agent-learning-gate benchmark: ${summary.passed}/${summary.total} passed`,
    ...rows
      .filter((row) => !row.passed)
      .map(
        (row) =>
          `FAIL ${row.id}: expected ${row.expected_decision} ${row.expected_codes.join(",")} ` +
          `got ${row.actual_decision} ${row.actual_codes.join(",")}`,
      ),
  ];
  return `${lines.join("\n")}\n`;
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    return EXIT_CODES.PASS;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    process.stdout.write("agent-learning-gate 0.2.0\n");
    return EXIT_CODES.PASS;
  }

  const format = option(argv, "--format", "text");
  if (!new Set(["text", "json"]).has(format)) {
    throw new Error(`Unsupported format '${format}'.`);
  }

  if (command === "demo") {
    const result = checkProposal(demoDocument());
    process.stdout.write(formatResult(result, format));
    return resultExitCode(result);
  }

  if (command === "state-dir" || command === "proposal-dir") {
    const projectDir = option(argv, "--project-dir", process.cwd());
    ensurePrivateStateRoot(projectDir);
    const stateRoot = projectStateRoot(projectDir);
    const outputPath = command === "proposal-dir" ? path.join(stateRoot, "proposals") : stateRoot;
    if (command === "proposal-dir") {
      fs.mkdirSync(outputPath, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(outputPath, 0o700);
      } catch {
        // Windows and some filesystems do not expose POSIX modes.
      }
    }
    process.stdout.write(`${outputPath}\n`);
    return EXIT_CODES.PASS;
  }

  if (command === "capabilities") {
    const host = argv[1] && !argv[1].startsWith("--") ? argv[1] : null;
    const value = host ? hostCapability(host) : HOST_CAPABILITIES;
    if (!value) throw new Error(`Unsupported host '${host}'.`);
    const entries = host ? [value] : Object.values(value);
    process.stdout.write(
      format === "json"
        ? `${JSON.stringify(value, null, 2)}\n`
        : `${entries.map((entry) => `${entry.host}: ${entry.enforcement}`).join("\n")}\n`,
    );
    return EXIT_CODES.PASS;
  }

  const filePath = argv[1];
  if (!filePath) throw new Error(`${command} requires a file path.`);

  if (command === "check") {
    const result = checkProposal(readJson(filePath));
    process.stdout.write(formatResult(result, format));
    return resultExitCode(result);
  }

  if (command === "review") {
    const projectDir = option(argv, "--project-dir");
    const host = option(argv, "--host", "generic");
    if (!projectDir) throw new Error("review requires --project-dir <path>.");
    if (!hostCapability(host)) throw new Error(`Unsupported host '${host}'.`);
    try {
      const { reviewed, receipt, receiptPath } = recordReview(readJson(filePath), {
        projectDir,
        host,
      });
      const output = {
        decision: DECISIONS.PASS,
        state: "REVIEWED",
        host,
        target_path: redactHome(reviewed.targetPath),
        operation_sha256: reviewed.operationHash,
        preimage_sha256: reviewed.preimageSha256,
        postimage_sha256: reviewed.postimageSha256,
        receipt_id: receipt.receipt_id,
        receipt_digest: receipt.receipt_digest,
        receipt_path: receiptPath,
        authorizes_write: false,
        validated_delta: reviewed.binding.delta,
        operation: reviewed.operation,
      };
      process.stdout.write(
        format === "json"
          ? `${JSON.stringify(output, null, 2)}\n`
          : `agent-learning-gate: PASS\nReviewed exact ${reviewed.tool} for ${output.target_path}.\n` +
            `Receipt: ${receiptPath}\nReceipt digest: ${receipt.receipt_digest}\n` +
            `Validated delta (JSON string): ${JSON.stringify(reviewed.binding.delta)}\n` +
            `Exact operation: ${JSON.stringify(reviewed.operation)}\n` +
            "This receipt does not authorize a write.\n",
      );
      return EXIT_CODES.PASS;
    } catch (error) {
      if (error.result) {
        process.stdout.write(formatResult(error.result, format));
        return resultExitCode(error.result);
      }
      throw error;
    }
  }

  if (command === "verify") {
    const verification = verifyReviewReceipt(filePath);
    const output = {
      decision: verification.matched ? DECISIONS.PASS : DECISIONS.BLOCK,
      state: verification.status,
      receipt_id: verification.receipt.receipt_id,
      receipt_digest: verification.receipt.receipt_digest,
      target_path: redactHome(verification.targetPath),
      expected_postimage_sha256: verification.receipt.postimage_sha256,
      current_sha256: verification.currentSha256,
    };
    process.stdout.write(
      format === "json"
        ? `${JSON.stringify(output, null, 2)}\n`
        : `agent-learning-gate: ${output.decision}\n${output.state}: ${output.target_path}\n` +
          `Expected ${output.expected_postimage_sha256}; found ${output.current_sha256}.\n`,
    );
    return verification.matched ? EXIT_CODES.PASS : EXIT_CODES.BLOCK;
  }

  if (command === "stage") {
    const projectDir = option(argv, "--project-dir");
    if (!projectDir) throw new Error("stage requires --project-dir <path>.");
    const ttlSeconds = Number(option(argv, "--ttl-seconds", "300"));
    const host = option(argv, "--host");
    if (!host) throw new Error("stage requires --host <claude-code|pi>.");
    const capability = hostCapability(host);
    if (!capability || !capability.native_write_ask) {
      throw new Error(
        `Host '${host}' has no trusted v0 approval channel; run check, present the proposal/diff, and let the user apply it outside the Agent.`,
      );
    }
    const document = readJson(filePath);
    try {
      const staged = stageProposal(document, {
        projectDir,
        proposalFile: filePath,
        ttlMs: ttlSeconds * 1000,
        host,
      });
      const { permit, permitPath } = staged;
      const output = {
        decision: DECISIONS.PASS,
        permit_id: permit.permit_id,
        target_path: redactHome(permit.target_path),
        expires_at: permit.expires_at,
        permit_path: redactHome(permitPath),
      };
      process.stdout.write(
        format === "json"
          ? `${JSON.stringify(output, null, 2)}\n`
          : `agent-learning-gate: PASS\nStaged request ${permit.permit_id} will ask the user once for the exact ${permit.tool} to ${output.target_path}; it expires at ${permit.expires_at}.\n`,
      );
      return EXIT_CODES.PASS;
    } catch (error) {
      if (error.result) {
        process.stdout.write(formatResult(error.result, format));
        return resultExitCode(error.result);
      }
      throw error;
    }
  }

  if (command === "benchmark") {
    const report = runBenchmark(filePath, format);
    process.stdout.write(report);
    const parsed = format === "json" ? JSON.parse(report) : null;
    if (parsed) return parsed.failed === 0 ? EXIT_CODES.PASS : 1;
    const hasFailure = report.includes("\nFAIL ");
    return hasFailure ? 1 : EXIT_CODES.PASS;
  }

  throw new Error(`Unknown command '${command}'.\n\n${usage()}`);
}

export async function runCli() {
  try {
    const code = await main();
    process.exitCode = code;
  } catch (error) {
    process.stderr.write(`agent-learning-gate error: ${error.message}\n`);
    process.exitCode = EXIT_CODES.INVALID_INPUT;
  }
}
