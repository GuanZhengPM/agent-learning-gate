import assert from "node:assert/strict";
import test from "node:test";

import { checkProposal } from "../lib/engine.mjs";

function document(overrides = {}) {
  return {
    evidence: {
      text: "Remember that this repository uses uv run pytest.",
      source_turn: "turn-test-1",
      kind: "explicit_remember",
      scope: "workspace",
      explicit_persistence: true,
    },
    current: { artifacts: [], active_scope: "workspace:test" },
    proposal: {
      target: "memory",
      content: "This repository uses uv run pytest.",
      scope: "workspace",
      durability: "stable",
    },
    ...overrides,
  };
}

test("passes an explicitly requested workspace memory", () => {
  const result = checkProposal(document());
  assert.equal(result.decision, "PASS");
  assert.deepEqual(result.issues, []);
});

test("an explicit named durable-file write is persistence evidence", () => {
  const input = document({
    evidence: {
      text: "Create AGENTS.md with exactly this rule: Use uv run pytest.",
      kind: "explicit_instruction",
      scope: "workspace",
      explicit_persistence: true,
    },
    proposal: {
      target: "AGENTS.md",
      content: "Use uv run pytest.",
      scope: "workspace",
      durability: "stable",
    },
  });
  const result = checkProposal(input);
  assert.equal(result.decision, "PASS");
});

test("blocks a workspace preference widened to a task-family branch", () => {
  const input = document();
  input.proposal.scope = "task_family";
  const result = checkProposal(input);
  assert.equal(result.decision, "BLOCK");
  assert.ok(result.issues.some((entry) => entry.code === "E201_SCOPE_WIDENING"));
});

test("abstains on turn-level praise kept as an observation", () => {
  const result = checkProposal(
    document({
      evidence: {
        text: "Nice work.",
        source_turn: "turn-test-2",
        kind: "implicit_praise",
        scope: "turn",
        explicit_persistence: false,
      },
      proposal: {
        target: "memory",
        content: "Conciseness may have helped this response.",
        scope: "turn",
        durability: "observation",
      },
    }),
  );
  assert.equal(result.decision, "ABSTAIN");
  assert.deepEqual(result.issues.map((entry) => entry.code), ["E401_AMBIGUOUS_REWARD"]);
});

test("blocks a complete skill routed from a factual statement", () => {
  const result = checkProposal(
    document({
      evidence: {
        text: "This repository requires Node.js 22.",
        source_turn: "turn-test-3",
        kind: "factual_statement",
        scope: "workspace",
        explicit_persistence: true,
      },
      proposal: {
        target: "skill",
        content: "Use Node.js 22.",
        scope: "workspace",
        durability: "procedure",
        trigger: "When running the repository",
        steps: ["Select Node.js 22"],
        success_criteria: ["The process reports Node.js 22"],
      },
    }),
  );
  assert.equal(result.decision, "BLOCK");
  assert.ok(result.issues.some((entry) => entry.code === "E101_WRONG_DESTINATION"));
});

test("allows an explicit replacement when supersedes names the old artifact", () => {
  const input = document();
  input.evidence.text = "From now on, replace direct pytest with uv run pytest in this repository.";
  input.current.artifacts = [
    {
      id: "old-runner",
      key: "test-runner",
      target: "memory",
      scope: "workspace",
      status: "active",
      content: "This repository runs pytest directly.",
    },
  ];
  input.proposal.key = "test-runner";
  input.proposal.supersedes = ["old-runner"];
  const result = checkProposal(input);
  assert.equal(result.decision, "PASS");
});

test("does not treat workspace and task-family scopes as overlapping", () => {
  const input = document({
    evidence: {
      text: "In this private workspace, do not include external citations.",
      source_turn: "turn-test-4",
      kind: "explicit_preference",
      scope: "workspace",
      explicit_persistence: true,
    },
    current: {
      artifacts: [
        {
          id: "research-citations",
          target: "agent.md",
          scope: "task_family",
          status: "active",
          content: "Include citations in research answers.",
        },
      ],
    },
    proposal: {
      target: "agent.md",
      content: "Do not include citations in this private workspace.",
      scope: "workspace",
      durability: "stable",
    },
  });
  const result = checkProposal(input);
  assert.equal(result.decision, "PASS");
});

test("rejects Nice work mislabeled as an explicit remember request", () => {
  const input = document({
    evidence: {
      text: "Nice work.",
      source_turn: "turn-test-5",
      kind: "explicit_remember",
      scope: "global",
      explicit_persistence: true,
    },
    proposal: {
      target: "agent.md",
      content: "Always use tables.",
      scope: "global",
      durability: "stable",
    },
  });
  const result = checkProposal(input);
  assert.equal(result.decision, "BLOCK");
  assert.ok(result.issues.some((entry) => entry.code === "E001_INVALID_INPUT"));
});

test("rejects unknown evidence kinds instead of rewarding repeated typos", () => {
  const item = {
    text: "Looks good.",
    source_turn: "same-turn",
    kind: "implicit_prasie",
    scope: "global",
    explicit_persistence: false,
  };
  const input = document({
    evidence: [item, item, item],
    proposal: {
      target: "memory",
      content: "The user likes tables.",
      scope: "global",
      durability: "stable",
    },
  });
  const result = checkProposal(input);
  assert.equal(result.decision, "BLOCK");
  assert.ok(result.issues.some((entry) => entry.code === "E001_INVALID_INPUT"));
});

test("a confirmation flag cannot promote weak evidence", () => {
  const input = document({
    evidence: {
      text: "This answer is shorter.",
      source_turn: "turn-test-6",
      kind: "uncertain",
      scope: "turn",
      explicit_persistence: false,
    },
    proposal: {
      target: "agent.md",
      content: "Always answer briefly.",
      scope: "global",
      durability: "stable",
    },
    user_confirmation: {
      confirmed: true,
      evidence: "model-authored field",
    },
  });
  const result = checkProposal(input);
  assert.equal(result.decision, "BLOCK");
  assert.ok(result.issues.some((entry) => entry.code === "E201_SCOPE_WIDENING"));
});

test("runtime validation rejects schema-invalid primitive types and casing", () => {
  const invalidDocuments = [];
  {
    const input = document();
    input.evidence.text = 123;
    input.proposal.content = 456;
    invalidDocuments.push(input);
  }
  {
    const input = document();
    input.evidence.explicit_persistence = "false";
    invalidDocuments.push(input);
  }
  for (const [field, value] of [
    ["kind", "EXPLICIT_REMEMBER"],
    ["scope", "WORKSPACE"],
  ]) {
    const input = document();
    input.evidence[field] = value;
    invalidDocuments.push(input);
  }
  {
    const input = document();
    input.proposal.target = "MEMORY";
    invalidDocuments.push(input);
  }
  for (const input of invalidDocuments) {
    const result = checkProposal(input);
    assert.equal(result.decision, "BLOCK");
    assert.ok(result.issues.some((entry) => entry.code === "E001_INVALID_INPUT"));
  }
});

test("blocks generic English and Chinese polarity reversals", () => {
  const cases = [
    ["Always produce tables.", "Never produce tables."],
    ["Include citations.", "Do not include citations."],
    ["始终先给结论。", "不要先给结论。"],
  ];
  for (const [evidenceText, proposalText] of cases) {
    const input = document({
      evidence: {
        text: `Remember: ${evidenceText}`,
        kind: "explicit_remember",
        scope: "global",
        explicit_persistence: true,
      },
      proposal: {
        target: "agent.md",
        content: proposalText,
        scope: "global",
        durability: "stable",
      },
    });
    const result = checkProposal(input);
    assert.equal(result.decision, "BLOCK", `${evidenceText} -> ${proposalText}`);
    assert.ok(result.issues.some((entry) => entry.code === "E503_POLARITY_REVERSAL"));
  }
});

test("blocks negative action verbs that reverse a supported tool preference", () => {
  for (const action of ["Ban", "Disable", "Remove", "Reject", "Drop", "Forbid", "Suppress"]) {
    const input = document({
      evidence: {
        text: "Remember to use uv in this workspace.",
        kind: "explicit_remember",
        scope: "workspace",
        explicit_persistence: true,
      },
      proposal: {
        target: "agent.md",
        content: `${action} uv.`,
        scope: "workspace",
        durability: "stable",
      },
    });
    const result = checkProposal(input);
    assert.equal(result.decision, "BLOCK", action);
    assert.ok(result.issues.some((entry) => entry.code === "E503_POLARITY_REVERSAL"));
  }
});

test("blocks generic Chinese removal and shutdown reversals", () => {
  for (const [source, proposal] of [
    ["请记住始终保留引用。", "去掉引用。"],
    ["请记住始终开启日志。", "关闭日志。"],
    ["请记住始终保留用户反馈。", "忽略用户反馈。"],
    ["请记住始终保留日志。", "清空日志。"],
  ]) {
    const input = document({
      evidence: {
        text: source,
        kind: "explicit_remember",
        scope: "global",
        explicit_persistence: true,
      },
      proposal: {
        target: "agent.md",
        content: proposal,
        scope: "global",
        durability: "stable",
      },
    });
    const result = checkProposal(input);
    assert.equal(result.decision, "BLOCK");
    assert.ok(result.issues.some((entry) => entry.code === "E503_POLARITY_REVERSAL"));
  }
});

test("blocks generic English ignore, erase, and disregard reversals", () => {
  for (const [source, proposal] of [
    ["Remember to always consider user feedback.", "Ignore user feedback."],
    ["Remember to retain logs.", "Erase logs."],
    ["Remember to always honor citations.", "Disregard citations."],
  ]) {
    const input = document({
      evidence: {
        text: source,
        kind: "explicit_remember",
        scope: "global",
        explicit_persistence: true,
      },
      proposal: {
        target: "agent.md",
        content: proposal,
        scope: "global",
        durability: "stable",
      },
    });
    const result = checkProposal(input);
    assert.equal(result.decision, "BLOCK");
    assert.ok(result.issues.some((entry) => entry.code === "E503_POLARITY_REVERSAL"));
  }
});

test("a quoted forbidden phrase is not mistaken for a positive preference", () => {
  const input = document({
    evidence: {
      text: "这个项目的 README 不要 AI 味，也不要‘不是…而是…’的话术。",
      kind: "explicit_preference",
      scope: "workspace",
      explicit_persistence: true,
    },
    proposal: {
      target: "agent.md",
      content: "README 避免 AI 腔与‘不是…而是…’句式。",
      scope: "workspace",
      durability: "stable",
    },
  });
  const result = checkProposal(input);
  assert.equal(
    result.issues.some((entry) => entry.code === "E503_POLARITY_REVERSAL"),
    false,
  );
});

test("rejects evidence metadata that broadens an explicit textual scope", () => {
  const input = document({
    evidence: {
      text: "For this task, always use tables.",
      kind: "explicit_preference",
      scope: "global",
      explicit_persistence: true,
    },
    proposal: {
      target: "agent.md",
      content: "Always use tables.",
      scope: "global",
      durability: "stable",
    },
  });
  const result = checkProposal(input);
  assert.equal(result.decision, "BLOCK");
  assert.ok(result.issues.some((entry) => entry.code === "E001_INVALID_INPUT"));
});

test("rejects global metadata for today, for-now, and one-time instructions", () => {
  for (const text of [
    "Remember: for today, use tables.",
    "Today, always use tables.",
    "Just today, always use tables.",
    "Remember: only for now, use tables.",
    "Remember: just this once, use tables.",
    "Remember: until tomorrow, use tables.",
    "Remember: for the next hour, use tables.",
    "记住，今天临时使用表格。",
    "记住，接下来两个小时使用表格。",
  ]) {
    const input = document({
      evidence: {
        text,
        kind: "explicit_remember",
        scope: "global",
        explicit_persistence: true,
      },
      proposal: {
        target: "agent.md",
        content: "Always use tables.",
        scope: "global",
        durability: "stable",
      },
    });
    const result = checkProposal(input);
    assert.equal(result.decision, "BLOCK", text);
    assert.ok(result.issues.some((entry) => entry.code === "E001_INVALID_INPUT"));
  }
});

test("a transient observation does not erase separate explicit durable evidence", () => {
  const input = document({
    evidence: [
      {
        text: "For this turn, show the raw command.",
        kind: "one_off_instruction",
        scope: "turn",
        explicit_persistence: false,
      },
      {
        text: "Remember that this repository uses uv run pytest.",
        kind: "explicit_remember",
        scope: "workspace",
        explicit_persistence: true,
      },
    ],
  });
  const result = checkProposal(input);
  assert.equal(result.decision, "PASS");
});

test("replacement language does not conflict with unrelated memories", () => {
  const input = document();
  input.evidence.text = "From now on, replace direct pytest with uv run pytest in this repository.";
  input.current.artifacts = [
    {
      id: "unrelated-style",
      target: "memory",
      scope: "workspace",
      status: "active",
      content: "Status updates use short paragraphs.",
    },
  ];
  input.proposal.supersedes = ["old-runner-not-present"];
  const result = checkProposal(input);
  assert.equal(result.decision, "PASS");
});

test("a replacement must name the related active artifact", () => {
  const input = document();
  input.evidence.text = "This repository should replace direct pytest with uv run pytest from now on.";
  input.current.artifacts = [
    {
      id: "old-runner",
      target: "memory",
      scope: "workspace",
      status: "active",
      content: "This repository runs pytest directly.",
    },
  ];
  input.proposal.supersedes = [];
  const result = checkProposal(input);
  assert.equal(result.decision, "BLOCK");
  assert.ok(result.issues.some((entry) => entry.code === "E301_CONFLICT"));
});

test("a supported clause cannot smuggle an unsupported second lesson", () => {
  for (const content of [
    "Use uv run pytest and use tables.",
    "Use uv run pytest and use npm.",
    "Use uv run pytest and use rm -rf.",
    "Use uv run pytest instead of npm.",
    "Use uv run pytest, use tables.",
    "Use uv run pytest with tables.",
    "Use uv run pytest while collecting analytics.",
    "Use uv run pytest before posting metrics.",
    "使用 uv run pytest，并且使用表格。",
    "使用 uv run pytest，同时使用表格。",
    "使用 uv run pytest，使用表格。",
    "使用 uv run pytest后记录用户数据。",
    "使用 uv run pytest时收集用户数据。",
  ]) {
    const input = document();
    input.proposal = {
      target: "agent.md",
      content,
      scope: "workspace",
      durability: "stable",
    };
    const result = checkProposal(input);
    assert.notEqual(result.decision, "PASS", content);
    assert.ok(
      result.issues.some((entry) => entry.code === "E502_UNSUPPORTED_LESSON"),
      content,
    );
  }
});

test("a shared named entity can support a conservative paraphrase", () => {
  const input = document({
    evidence: {
      text: "下次及以后的推送记得别把 Provider-X 的消耗漏掉了。",
      kind: "explicit_remember",
      scope: "task_family",
      explicit_persistence: true,
    },
    proposal: {
      target: "memory",
      content: "之后所有推送汇报都必须包含 Provider-X 消耗，不可遗漏。",
      scope: "task_family",
      durability: "stable",
    },
  });
  const result = checkProposal(input);
  assert.equal(
    result.issues.some((entry) => entry.code === "E502_UNSUPPORTED_LESSON"),
    false,
  );
});

test("session-only behavior cannot be written to a durable policy file", () => {
  const input = document({
    evidence: {
      text: "In this session, keep running unless token use becomes excessive.",
      kind: "explicit_preference",
      scope: "session",
      explicit_persistence: true,
    },
    proposal: {
      target: "agent.md",
      content: "Keep running while token use is controlled.",
      scope: "session",
      durability: "stable",
    },
  });
  const result = checkProposal(input);
  assert.equal(result.decision, "BLOCK");
  assert.ok(result.issues.some((entry) => entry.code === "E101_WRONG_DESTINATION"));
});

test("transient memory and skills cannot claim stable or procedure durability", () => {
  for (const proposal of [
    {
      target: "memory",
      content: "Use tables in this session.",
      scope: "session",
      install_scope: "workspace",
      durability: "stable",
    },
    {
      target: "skill",
      content: "Use tables in this session.",
      scope: "session",
      install_scope: "workspace",
      durability: "procedure",
      trigger: "A response is requested",
      steps: ["Use tables"],
      success_criteria: ["The response contains a table"],
    },
  ]) {
    const input = document({
      evidence: {
        text: "Remember: in this session, use tables for every response.",
        kind: "explicit_remember",
        scope: "session",
        explicit_persistence: true,
      },
      proposal,
    });
    const result = checkProposal(input);
    assert.equal(result.decision, "BLOCK");
    assert.ok(result.issues.some((entry) => entry.code === "E202_ONE_OFF_AS_PERSISTENT"));
  }
});

test("a one-time repository push cannot hide inside a durable procedure", () => {
  const input = document({
    evidence: {
      text: "Write a bilingual README and then push it to this private repository.",
      kind: "explicit_instruction",
      scope: "workspace",
      explicit_persistence: true,
    },
    proposal: {
      target: "agent.md",
      content: "Use a bilingual README; after completion, push it to the private repository.",
      scope: "workspace",
      durability: "procedure",
    },
  });
  const result = checkProposal(input);
  assert.equal(result.decision, "BLOCK");
  assert.ok(result.issues.some((entry) => entry.code === "E202_ONE_OFF_AS_PERSISTENT"));
});
