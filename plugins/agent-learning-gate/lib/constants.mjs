export const DECISIONS = Object.freeze({
  PASS: "PASS",
  BLOCK: "BLOCK",
  ABSTAIN: "ABSTAIN",
});

export const EXIT_CODES = Object.freeze({
  PASS: 0,
  BLOCK: 2,
  ABSTAIN: 3,
  INVALID_INPUT: 4,
  INTERNAL_ERROR: 5,
});

export const ERROR_CODES = Object.freeze({
  INVALID_INPUT: "E001_INVALID_INPUT",
  WRONG_DESTINATION: "E101_WRONG_DESTINATION",
  SCOPE_WIDENING: "E201_SCOPE_WIDENING",
  ONE_OFF_AS_PERSISTENT: "E202_ONE_OFF_AS_PERSISTENT",
  CONFLICT: "E301_CONFLICT",
  AMBIGUOUS_REWARD: "E401_AMBIGUOUS_REWARD",
  MIXED_OR_SARCASTIC_FEEDBACK: "E402_MIXED_OR_SARCASTIC_FEEDBACK",
  INSUFFICIENT_EVIDENCE: "E501_INSUFFICIENT_EVIDENCE",
  UNSUPPORTED_LESSON: "E502_UNSUPPORTED_LESSON",
  POLARITY_REVERSAL: "E503_POLARITY_REVERSAL",
  SKILL_LACKS_PROCEDURE: "E601_SKILL_LACKS_PROCEDURE",
  UNCONFIRMED: "E601_UNCONFIRMED",
  OPERATION_MISMATCH: "E701_OPERATION_MISMATCH",
});

export const SCOPE_ORDER = Object.freeze([
  "turn",
  "session",
  "task",
  "workspace",
  "project",
  "task_family",
  "domain",
  "global",
]);

export const SCOPE_COVERAGE = Object.freeze({
  turn: ["turn"],
  session: ["session", "turn"],
  task: ["task", "session", "turn"],
  workspace: ["workspace", "project", "task", "session", "turn"],
  project: ["workspace", "project", "task", "session", "turn"],
  task_family: ["task_family", "task", "session", "turn"],
  domain: ["domain", "task_family", "task", "session", "turn"],
  global: [
    "global",
    "domain",
    "task_family",
    "workspace",
    "project",
    "task",
    "session",
    "turn",
  ],
});

export const DURABILITY_ORDER = Object.freeze([
  "observation",
  "candidate",
  "trial",
  "active",
  "permanent",
]);

export const TARGET_ALIASES = Object.freeze({
  memory: "memory",
  "auto-memory": "memory",
  user: "memory",
  "agent.md": "policy",
  "AGENT.md": "policy",
  agents: "policy",
  "agents.md": "policy",
  "AGENTS.md": "policy",
  "claude.md": "policy",
  "CLAUDE.md": "policy",
  policy: "policy",
  rule: "rule",
  rules: "rule",
  skill: "skill",
  "skill.md": "skill",
  "SKILL.md": "skill",
});

export const AMBIGUOUS_EVIDENCE_KINDS = new Set([
  "implicit_praise",
  "implicit_dislike",
  "implicit_feedback",
  "acknowledgement",
  "sarcasm",
  "uncertain",
]);

export const EXPLICIT_EVIDENCE_KINDS = new Set([
  "explicit_preference",
  "explicit_correction",
  "explicit_instruction",
  "explicit_remember",
  "explicit_constraint",
]);

export const ONE_OFF_EVIDENCE_KINDS = new Set([
  "one_off_instruction",
  "session_instruction",
  "task_instruction",
]);

export const ALLOWED_EVIDENCE_KINDS = new Set([
  ...AMBIGUOUS_EVIDENCE_KINDS,
  ...EXPLICIT_EVIDENCE_KINDS,
  ...ONE_OFF_EVIDENCE_KINDS,
  "explicit_preference",
  "explicit_correction",
  "explicit_instruction",
  "explicit_remember",
  "explicit_constraint",
  "implicit_praise",
  "implicit_dislike",
  "implicit_feedback",
  "acknowledgement",
  "mixed_feedback",
  "sarcasm",
  "uncertain",
  "factual_statement",
  "procedure_request",
]);

export const BLOCKING_CODES = new Set([
  ERROR_CODES.INVALID_INPUT,
  ERROR_CODES.WRONG_DESTINATION,
  ERROR_CODES.SCOPE_WIDENING,
  ERROR_CODES.ONE_OFF_AS_PERSISTENT,
  ERROR_CODES.CONFLICT,
  ERROR_CODES.MIXED_OR_SARCASTIC_FEEDBACK,
  ERROR_CODES.SKILL_LACKS_PROCEDURE,
  ERROR_CODES.POLARITY_REVERSAL,
  ERROR_CODES.OPERATION_MISMATCH,
]);
