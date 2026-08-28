import {
  ALLOWED_EVIDENCE_KINDS,
  AMBIGUOUS_EVIDENCE_KINDS,
  BLOCKING_CODES,
  DECISIONS,
  DURABILITY_ORDER,
  ERROR_CODES,
  EXPLICIT_EVIDENCE_KINDS,
  ONE_OFF_EVIDENCE_KINDS,
  SCOPE_COVERAGE,
  SCOPE_ORDER,
  TARGET_ALIASES,
} from "./constants.mjs";
import { asArray, normalizeText } from "./utils.mjs";

function issue(code, message, details = {}) {
  return { code, message, details };
}

function rank(order, value) {
  return order.indexOf(String(value || "").toLowerCase());
}

function normalizeTarget(target) {
  return TARGET_ALIASES[String(target || "").toLowerCase()] || null;
}

function normalizeDurability(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "stable" || normalized === "procedure") return "active";
  return normalized;
}

function hasPersistenceCue(text) {
  return /(?:记住|记成|记录为|以后|下次|从今|一直|所有|每次|都要|永远|这个项目|当前项目|这个仓库|当前仓库|这个工作区|当前工作区|remember|turn .* into a skill|from now on|in the future|always|never|whenever|every time|all projects|this(?:\s+[\p{L}\p{N}_-]+){0,3}\s+(?:project|repository|repo|workspace)|(?:create|write|update|edit|add|创建|写入|更新|修改|新增).{0,40}(?:AGENTS(?:\.override)?\.md|CLAUDE(?:\.local)?\.md|SKILL\.md|\.cursorrules|SYSTEM\.md|APPEND_SYSTEM\.md|\.cursor[/\\]rules))/iu.test(
    String(text || ""),
  );
}

function hasTemporalPersistenceCue(text) {
  return /(?:记住|以后|下次|从今|一直|所有|每次|都要|永远|remember|from now on|in the future|always|never|whenever|every time)/iu.test(
    String(text || ""),
  );
}

function inferredTextScope(text) {
  const value = String(text || "").normalize("NFKC");
  if (/(?:for\s+)?this\s+(?:turn|response)|这一轮|本轮|这条回复/iu.test(value)) {
    return "turn";
  }
  if (/(?:for|in)\s+this\s+(?:session|conversation)|this\s+chat|本会话|这个会话|当前会话|这段对话/iu.test(value)) {
    return "session";
  }
  if (/(?:for\s+)?this\s+(?:task|time)|current\s+task|这次|本次|当前任务|这个任务/iu.test(value)) {
    return "task";
  }
  if (
    /(?:(?:for\s+|just\s+)?today\b|only\s+for\s+now|for\s+now|just\s+this\s+once|this\s+once|one[- ]time|temporar(?:y|ily)|\buntil\b|\btomorrow\b|\btonight\b|this\s+(?:morning|afternoon|evening|week|month)|for\s+the\s+next\s+(?:\d+|one|two|few|several)?\s*(?:minutes?|hours?|days?|weeks?|months?|turns?|sessions?)|今天|明天|今晚|暂时|临时|直到|仅这一次|就这一次|只这一次|接下来.{0,12}(?:分钟|小时|天|周|个月|轮|次|会话)|未来.{0,12}(?:分钟|小时|天|周|个月))/iu.test(
      value,
    )
  ) {
    return "task";
  }
  if (
    /this(?:\s+[\p{L}\p{N}_-]+){0,3}\s+(?:project|repository|repo|workspace)|这个项目|当前项目|本项目|这个仓库|当前仓库|本仓库|这个工作区|当前工作区/iu.test(
      value,
    )
  ) {
    return "workspace";
  }
  return null;
}

function deduplicateEvidence(evidence) {
  const seen = new Set();
  const output = [];
  for (const item of evidence) {
    const key = normalizeText(`${item?.source_turn || ""}\0${item?.text || ""}`);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function rejectUnknownFields(value, allowed, context, issues) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    issues.push(
      issue(ERROR_CODES.INVALID_INPUT, `${context} contains unsupported fields.`, {
        unexpected,
      }),
    );
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireStringArray(value, context, issues, { allowEmpty = true } = {}) {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((entry) => typeof entry !== "string" || (!allowEmpty && !entry.trim()))
  ) {
    issues.push(issue(ERROR_CODES.INVALID_INPUT, `${context} must be an array of strings.`));
  }
}

function validateInput(input) {
  const issues = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return [issue(ERROR_CODES.INVALID_INPUT, "Proposal input must be a JSON object.")];
  }
  rejectUnknownFields(
    input,
    new Set(["id", "session_id", "evidence", "current", "proposal", "user_confirmation"]),
    "Proposal document",
    issues,
  );
  for (const field of ["id", "session_id"]) {
    if (input[field] !== undefined && typeof input[field] !== "string") {
      issues.push(issue(ERROR_CODES.INVALID_INPUT, `${field} must be a string.`));
    }
  }
  const evidence = asArray(input.evidence);
  const proposal = input.proposal;
  if (evidence.length === 0) {
    issues.push(issue(ERROR_CODES.INVALID_INPUT, "At least one evidence item is required."));
  }
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
    issues.push(issue(ERROR_CODES.INVALID_INPUT, "A proposal object is required."));
    return issues;
  }
  rejectUnknownFields(
    proposal,
    new Set([
      "target", "content", "scope", "install_scope", "durability", "key", "value",
      "replaces", "supersedes", "procedure", "trigger", "steps", "success_criteria",
      "operation",
    ]),
    "proposal",
    issues,
  );
  for (const field of ["target", "content", "scope", "durability"]) {
    if (typeof proposal[field] !== "string" || !proposal[field].trim()) {
      issues.push(
        issue(ERROR_CODES.INVALID_INPUT, `Proposal field '${field}' is required.`, { field }),
      );
    }
  }
  if (proposal.scope && !SCOPE_ORDER.includes(proposal.scope)) {
    issues.push(
      issue(ERROR_CODES.INVALID_INPUT, `Unsupported proposal scope '${proposal.scope}'.`, {
        allowed: SCOPE_ORDER,
      }),
    );
  }
  if (
    proposal.durability &&
    ![...DURABILITY_ORDER, "stable", "procedure"].includes(proposal.durability)
  ) {
    issues.push(
      issue(
        ERROR_CODES.INVALID_INPUT,
        `Unsupported proposal durability '${proposal.durability}'.`,
        { allowed: [...DURABILITY_ORDER, "stable", "procedure"] },
      ),
    );
  }
  if (
    proposal.target &&
    (typeof proposal.target !== "string" ||
      !Object.prototype.hasOwnProperty.call(TARGET_ALIASES, proposal.target))
  ) {
    issues.push(
      issue(ERROR_CODES.INVALID_INPUT, `Unsupported proposal target '${proposal.target}'.`, {
        allowed: Object.keys(TARGET_ALIASES),
      }),
    );
  }
  if (
    proposal.install_scope !== undefined &&
    !["workspace", "project", "global"].includes(proposal.install_scope)
  ) {
    issues.push(
      issue(ERROR_CODES.INVALID_INPUT, `Unsupported install_scope '${proposal.install_scope}'.`, {
        allowed: ["workspace", "project", "global"],
      }),
    );
  }
  if (proposal.supersedes && !Array.isArray(proposal.supersedes)) {
    issues.push(issue(ERROR_CODES.INVALID_INPUT, "proposal.supersedes must be an array."));
  } else if (proposal.supersedes) {
    requireStringArray(proposal.supersedes, "proposal.supersedes", issues);
    if (new Set(proposal.supersedes).size !== proposal.supersedes.length) {
      issues.push(issue(ERROR_CODES.INVALID_INPUT, "proposal.supersedes must contain unique values."));
    }
  }
  for (const field of ["key", "replaces"]) {
    if (proposal[field] !== undefined && typeof proposal[field] !== "string") {
      issues.push(issue(ERROR_CODES.INVALID_INPUT, `proposal.${field} must be a string.`));
    }
  }
  if (
    proposal.trigger !== undefined &&
    proposal.trigger !== null &&
    typeof proposal.trigger !== "string"
  ) {
    issues.push(issue(ERROR_CODES.INVALID_INPUT, "proposal.trigger must be a string or null."));
  }
  if (proposal.steps !== undefined) {
    requireStringArray(proposal.steps, "proposal.steps", issues);
  }
  if (proposal.success_criteria !== undefined) {
    if (typeof proposal.success_criteria !== "string") {
      requireStringArray(proposal.success_criteria, "proposal.success_criteria", issues);
    }
  }
  if (proposal.procedure !== undefined) {
    if (!isRecord(proposal.procedure)) {
      issues.push(issue(ERROR_CODES.INVALID_INPUT, "proposal.procedure must be an object."));
    } else {
      rejectUnknownFields(
        proposal.procedure,
        new Set(["trigger", "steps", "success_criteria"]),
        "proposal.procedure",
        issues,
      );
      if (typeof proposal.procedure.trigger !== "string" || !proposal.procedure.trigger.trim()) {
        issues.push(issue(ERROR_CODES.INVALID_INPUT, "proposal.procedure.trigger must be a non-empty string."));
      }
      requireStringArray(proposal.procedure.steps, "proposal.procedure.steps", issues, {
        allowEmpty: false,
      });
      if (typeof proposal.procedure.success_criteria === "string") {
        if (!proposal.procedure.success_criteria.trim()) {
          issues.push(issue(ERROR_CODES.INVALID_INPUT, "proposal.procedure.success_criteria must not be empty."));
        }
      } else {
        requireStringArray(
          proposal.procedure.success_criteria,
          "proposal.procedure.success_criteria",
          issues,
          { allowEmpty: false },
        );
      }
    }
  }
  if (proposal.operation !== undefined) {
    const operation = proposal.operation;
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
      issues.push(issue(ERROR_CODES.INVALID_INPUT, "proposal.operation must be an object."));
    } else {
      rejectUnknownFields(
        operation,
        new Set([
          "tool", "file_path", "content", "old_string", "new_string", "replace_all",
          "command", "adapter",
        ]),
        "proposal.operation",
        issues,
      );
      const tool = String(operation.tool || "").toLowerCase();
      if (
        operation.adapter !== undefined &&
        !["claude-code", "codex", "cursor", "pi", "generic"].includes(operation.adapter)
      ) {
        issues.push(issue(ERROR_CODES.INVALID_INPUT, "proposal.operation.adapter is unsupported."));
      }
      if (!new Set(["Write", "Edit", "write", "edit", "apply_patch"]).has(operation.tool)) {
        issues.push(
          issue(ERROR_CODES.INVALID_INPUT, "proposal.operation requires Write, Edit, or apply_patch."),
        );
      } else if (tool === "apply_patch") {
        if (typeof operation.command !== "string" || !operation.command.trim()) {
          issues.push(issue(ERROR_CODES.INVALID_INPUT, "apply_patch operation requires command."));
        }
        if (typeof operation.command === "string" && operation.command.length > 8_000) {
          issues.push(
            issue(ERROR_CODES.INVALID_INPUT, "Codex durable apply_patch is limited to 8000 characters."),
          );
        }
        if (operation.adapter !== "codex") {
          issues.push(
            issue(ERROR_CODES.INVALID_INPUT, "apply_patch operation requires adapter 'codex'."),
          );
        }
      } else if (typeof operation.file_path !== "string" || !operation.file_path) {
        issues.push(issue(ERROR_CODES.INVALID_INPUT, "Write/Edit operation requires file_path."));
      } else if (tool === "write" && typeof operation.content !== "string") {
        issues.push(issue(ERROR_CODES.INVALID_INPUT, "Write operation requires string content."));
      } else if (
        tool === "edit" &&
        (typeof operation.old_string !== "string" ||
          !operation.old_string ||
          typeof operation.new_string !== "string")
      ) {
        issues.push(
          issue(ERROR_CODES.INVALID_INPUT, "Edit operation requires non-empty old_string and string new_string."),
        );
      }
      if (operation.replace_all !== undefined && typeof operation.replace_all !== "boolean") {
        issues.push(issue(ERROR_CODES.INVALID_INPUT, "operation.replace_all must be boolean."));
      }
    }
  }
  evidence.forEach((item, index) => {
    if (!item || typeof item !== "object") {
      issues.push(
        issue(ERROR_CODES.INVALID_INPUT, `Evidence item ${index + 1} must be an object.`),
      );
      return;
    }
    rejectUnknownFields(
      item,
      new Set(["text", "kind", "scope", "role", "source_turn", "explicit_persistence"]),
      `Evidence item ${index + 1}`,
      issues,
    );
    if (
      typeof item.text !== "string" ||
      !item.text.trim() ||
      typeof item.kind !== "string" ||
      !item.kind ||
      typeof item.scope !== "string" ||
      !item.scope
    ) {
      issues.push(
        issue(
          ERROR_CODES.INVALID_INPUT,
          `Evidence item ${index + 1} requires text, kind, and scope.`,
          { index },
        ),
      );
    }
    const kind = String(item.kind || "");
    if (kind && !ALLOWED_EVIDENCE_KINDS.has(kind)) {
      issues.push(
        issue(ERROR_CODES.INVALID_INPUT, `Unsupported evidence kind '${item.kind}'.`, {
          index,
          allowed: [...ALLOWED_EVIDENCE_KINDS].sort(),
        }),
      );
    }
    if (item.role !== undefined && item.role !== "user") {
      issues.push(
        issue(ERROR_CODES.INVALID_INPUT, "Durable-learning evidence must come from the user role.", {
          index,
          role: item.role,
        }),
      );
    }
    if (
      item.explicit_persistence !== undefined &&
      typeof item.explicit_persistence !== "boolean"
    ) {
      issues.push(
        issue(ERROR_CODES.INVALID_INPUT, "evidence.explicit_persistence must be boolean.", {
          index,
        }),
      );
    }
    if (item.source_turn !== undefined && typeof item.source_turn !== "string") {
      issues.push(issue(ERROR_CODES.INVALID_INPUT, "evidence.source_turn must be a string.", { index }));
    }
    if (item.explicit_persistence === true && AMBIGUOUS_EVIDENCE_KINDS.has(kind)) {
      issues.push(
        issue(
          ERROR_CODES.INVALID_INPUT,
          `Ambiguous evidence kind '${item.kind}' cannot assert explicit persistence.`,
          { index },
        ),
      );
    }
    if (kind === "explicit_remember" && !hasPersistenceCue(item.text)) {
      issues.push(
        issue(
          ERROR_CODES.INVALID_INPUT,
          "Evidence labeled explicit_remember must contain an explicit persistence cue in the user text.",
          { index },
        ),
      );
    }
    if (item.scope && !SCOPE_ORDER.includes(item.scope)) {
      issues.push(
        issue(ERROR_CODES.INVALID_INPUT, `Unsupported evidence scope '${item.scope}'.`, {
          index,
          allowed: SCOPE_ORDER,
        }),
      );
    }
    const textualScope = inferredTextScope(item.text);
    if (textualScope && item.scope && !scopeSupports(textualScope, item.scope)) {
      issues.push(
        issue(
          ERROR_CODES.INVALID_INPUT,
          `Evidence text limits this instruction to '${textualScope}', but metadata claims '${item.scope}'.`,
          { index, textual_scope: textualScope, claimed_scope: item.scope },
        ),
      );
    }
  });
  if (input.current !== undefined) {
    if (!isRecord(input.current)) {
      issues.push(issue(ERROR_CODES.INVALID_INPUT, "current must be an object."));
    }
    rejectUnknownFields(
      input.current,
      new Set(["active_scope", "artifacts"]),
      "current",
      issues,
    );
    asArray(input.current?.artifacts).forEach((artifact, index) => {
      if (!isRecord(artifact)) {
        issues.push(issue(ERROR_CODES.INVALID_INPUT, `current.artifacts[${index}] must be an object.`));
        return;
      }
      rejectUnknownFields(
        artifact,
        new Set(["id", "key", "target", "scope", "status", "content", "value"]),
        `current.artifacts[${index}]`,
        issues,
      );
      for (const field of ["id", "key", "target", "scope", "status", "content"]) {
        if (artifact[field] !== undefined && typeof artifact[field] !== "string") {
          issues.push(
            issue(
              ERROR_CODES.INVALID_INPUT,
              `current.artifacts[${index}].${field} must be a string.`,
            ),
          );
        }
      }
      if (artifact.scope !== undefined && !SCOPE_ORDER.includes(artifact.scope)) {
        issues.push(
          issue(ERROR_CODES.INVALID_INPUT, `Unsupported artifact scope '${artifact.scope}'.`, {
            index,
          }),
        );
      }
      if (
        artifact.status !== undefined &&
        !["candidate", "trial", "active", "retired"].includes(artifact.status)
      ) {
        issues.push(
          issue(ERROR_CODES.INVALID_INPUT, `Unsupported artifact status '${artifact.status}'.`, {
            index,
          }),
        );
      }
    });
    if (
      input.current?.active_scope !== undefined &&
      (typeof input.current.active_scope !== "string" || !input.current.active_scope)
    ) {
      issues.push(issue(ERROR_CODES.INVALID_INPUT, "current.active_scope must be a non-empty string."));
    }
    if (input.current?.artifacts !== undefined && !Array.isArray(input.current.artifacts)) {
      issues.push(issue(ERROR_CODES.INVALID_INPUT, "current.artifacts must be an array."));
    }
  }
  if (input.user_confirmation !== undefined) {
    if (!isRecord(input.user_confirmation)) {
      issues.push(issue(ERROR_CODES.INVALID_INPUT, "user_confirmation must be an object."));
    }
    rejectUnknownFields(
      input.user_confirmation,
      new Set(["confirmed", "source_turn", "evidence"]),
      "user_confirmation",
      issues,
    );
    if (
      input.user_confirmation?.confirmed !== undefined &&
      typeof input.user_confirmation.confirmed !== "boolean"
    ) {
      issues.push(issue(ERROR_CODES.INVALID_INPUT, "user_confirmation.confirmed must be boolean."));
    }
    for (const field of ["source_turn", "evidence"]) {
      if (
        input.user_confirmation?.[field] !== undefined &&
        typeof input.user_confirmation[field] !== "string"
      ) {
        issues.push(issue(ERROR_CODES.INVALID_INPUT, `user_confirmation.${field} must be a string.`));
      }
    }
  }
  return issues;
}

function maxEvidenceScope(evidence) {
  let maximum = -1;
  for (const item of evidence) {
    maximum = Math.max(maximum, rank(SCOPE_ORDER, item.scope));
  }
  return maximum;
}

function scopeSupports(evidenceScope, proposalScope) {
  const coverage = SCOPE_COVERAGE[String(evidenceScope || "").toLowerCase()] || [];
  return coverage.includes(String(proposalScope || "").toLowerCase());
}

function evidenceStrength(evidence, input) {
  let score = 0;
  for (const item of evidence) {
    const kind = String(item.kind || "").toLowerCase();
    if (kind === "explicit_remember") score += 4;
    else if (kind === "procedure_request" && item.explicit_persistence) score += 4;
    else if (kind === "mixed_feedback" && item.explicit_persistence && hasPersistenceCue(item.text)) {
      score += 4;
    }
    else if (EXPLICIT_EVIDENCE_KINDS.has(kind)) {
      score += item.explicit_persistence && hasPersistenceCue(item.text) ? 4 : 3;
    }
    else if (ONE_OFF_EVIDENCE_KINDS.has(kind)) score += 1;
    else if (AMBIGUOUS_EVIDENCE_KINDS.has(kind)) score += 0;
    else score += 1;
  }
  if (evidence.length >= 2) score += 1;
  if (evidence.length >= 3) score += 1;
  return score;
}

const LATIN_STOPWORDS = new Set([
  "the",
  "this",
  "that",
  "with",
  "from",
  "into",
  "when",
  "then",
  "user",
  "current",
  "always",
  "never",
  "should",
  "must",
  "will",
  "your",
  "their",
  "have",
  "has",
  "for",
  "and",
  "a",
  "an",
  "in",
  "on",
  "of",
  "to",
  "as",
  "at",
  "by",
  "or",
  "is",
  "are",
  "be",
  "was",
  "were",
  "it",
  "its",
  "our",
  "we",
  "all",
  "only",
  "not",
  "use",
  "uses",
  "using",
  "run",
  "runs",
  "running",
  "do",
  "does",
  "make",
  "makes",
  "write",
  "writes",
  "include",
  "includes",
  "produce",
  "produces",
]);

const CJK_STOP_UNITS = new Set([
  "使用",
  "采用",
  "运行",
  "执行",
  "进行",
  "生成",
  "制作",
  "编写",
  "包括",
  "包含",
]);

function contentUnits(text) {
  const normalized = String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/遗漏/gu, "漏掉");
  const units = new Set();
  for (const rawWord of normalized.match(/[a-z0-9][a-z0-9._+-]*/g) || []) {
    const word = rawWord.replace(/[._+-]+$/g, "");
    if (word.length >= 2 && !LATIN_STOPWORDS.has(word)) {
      units.add(word);
      if (word.length > 4 && word.endsWith("ies")) {
        units.add(`${word.slice(0, -3)}y`);
      }
      if (
        word.length > 3 &&
        word.endsWith("s") &&
        !word.endsWith("ss") &&
        !word.endsWith("us") &&
        !word.endsWith("is")
      ) {
        units.add(word.slice(0, -1));
      }
    }
  }
  const cjkRuns = normalized.match(/[\p{Script=Han}]+/gu) || [];
  for (const run of cjkRuns) {
    if (run.length === 1) units.add(run);
    for (let index = 0; index < run.length - 1; index += 1) {
      const unit = run.slice(index, index + 2);
      if (!CJK_STOP_UNITS.has(unit)) units.add(unit);
    }
  }
  return units;
}

function semanticClauses(proposal) {
  const values = [proposal.content];
  if (normalizeTarget(proposal.target) === "skill") {
    values.push(proposal.procedure?.trigger ?? proposal.trigger);
    values.push(...asArray(proposal.procedure?.steps ?? proposal.steps));
    values.push(
      ...asArray(
        proposal.procedure?.success_criteria ?? proposal.success_criteria,
      ),
    );
  }
  return values
    .flatMap((value) =>
      String(value || "").split(
        /(?:[。；;,，\n]|\b(?:as\s+well\s+as|followed\s+by|and|also|with|while|before|after|when|whenever|then|plus|alongside|to)\b|以及|并且|同时|随后|然后|之后|之前|并(?=使用|采用|运行|生成|编写|添加|删除|包含|收集|记录|发送|上传|发布|推送|保存|跟踪)|后(?=使用|运行|收集|记录|发送|上传|删除|发布|推送|保存|跟踪)|时(?=使用|运行|收集|记录|发送|上传|删除|发布|推送|保存|跟踪))/iu,
      ),
    )
    .map((value) => value.trim())
    .filter(Boolean);
}

function technicalTokens(text) {
  const output = new Set();
  for (const raw of String(text || "").match(/[A-Za-z][A-Za-z0-9._+-]*/g) || []) {
    const token = raw.replace(/[._+-]+$/g, "").toLowerCase();
    if (!token || LATIN_STOPWORDS.has(token)) continue;
    const looksTechnical =
      token.length <= 4 ||
      /[0-9._+-]/.test(token) ||
      /[A-Z].*[A-Z]/.test(raw) ||
      /[a-z][A-Z]/.test(raw);
    if (looksTechnical) output.add(token);
  }
  return output;
}

function checkLexicalSupport(evidence, proposal) {
  if (proposal.durability === "observation") return null;
  const evidenceUnits = contentUnits(evidence.map((item) => item.text).join("\n"));
  const clauses = semanticClauses(proposal);
  const proposalUnits = contentUnits(clauses.join("\n"));
  if (proposalUnits.size === 0) {
    return issue(
      ERROR_CODES.UNSUPPORTED_LESSON,
      "Proposal content has no auditable lexical support units.",
      { coverage: 0 },
    );
  }
  const clauseCoverages = clauses.map((clause) => {
    const units = contentUnits(clause);
    if (units.size === 0) return 1;
    let overlap = 0;
    for (const unit of units) {
      if (evidenceUnits.has(unit)) overlap += 1;
    }
    return overlap / units.size;
  });
  const evidenceLatinUnits = new Set(
    [...evidenceUnits].filter((unit) => /[a-z0-9]/i.test(unit) && unit.length >= 2),
  );
  const evidenceTechnical = technicalTokens(evidence.map((item) => item.text).join("\n"));
  const clauseEntitySupport = clauses.map((clause) =>
    [...contentUnits(clause)].some(
      (unit) => /[a-z0-9]/i.test(unit) && evidenceLatinUnits.has(unit),
    ),
  );
  const unsupportedTechnical = clauses.map((clause) =>
    [...technicalTokens(clause)].filter((token) => !evidenceTechnical.has(token)),
  );
  let coverage = Math.min(...clauseCoverages);
  const highRiskTerms = [
    "secret",
    "secrets",
    "upload",
    "exfiltrate",
    "send",
    "external",
    "expose",
    "share",
    "forward",
    "publish",
    "delete",
    "collect",
    "analytics",
    "metrics",
    "posting",
    "post",
    "track",
    "tracking",
    "store",
    "telemetry",
    "network",
    "credential",
    "token",
    "密钥",
    "秘密",
    "上传",
    "外发",
    "删除",
    "收集",
    "记录用户",
    "用户数据",
    "发布指标",
    "上报指标",
    "埋点",
    "联网",
    "凭据",
  ];
  const evidenceText = normalizeText(evidence.map((item) => item.text).join(" "));
  const proposalText = normalizeText(proposal.content);
  const unsupportedRisk = highRiskTerms.filter(
    (term) => proposalText.includes(term) && !evidenceText.includes(term),
  );
  if (unsupportedRisk.length > 0) coverage = 0;
  const unsupportedClauses = clauseCoverages
    .map((value, index) => ({
      index,
      coverage: value,
      entity_supported: clauseEntitySupport[index],
    }))
    .filter(
      (entry) =>
        unsupportedTechnical[entry.index].length > 0 ||
        (
          entry.coverage < 0.3 &&
          !(entry.entity_supported && entry.coverage >= 0.15)
        ),
    );
  if (unsupportedRisk.length > 0 || unsupportedClauses.length > 0) {
    return issue(
      ERROR_CODES.UNSUPPORTED_LESSON,
      "Proposal content is not sufficiently extractive from the supplied user evidence.",
      {
        coverage: Number(coverage.toFixed(3)),
        threshold: 0.3,
        clause_coverages: clauseCoverages.map((value) => Number(value.toFixed(3))),
        entity_supported_clauses: clauseEntitySupport,
        unsupported_clause_indexes: unsupportedClauses.map((entry) => entry.index),
        unsupported_technical_tokens: unsupportedTechnical,
        unsupported_high_risk_terms: unsupportedRisk,
      },
    );
  }
  return null;
}

function collectUseRelations(text) {
  const positive = new Set();
  const negative = new Set();
  const normalized = String(text || "").normalize("NFKC").toLowerCase();
  for (const match of normalized.matchAll(/(?:\buse|\busing)\s+([a-z0-9._+-]+)/g)) {
    positive.add(match[1]);
  }
  for (const match of normalized.matchAll(/(?:do not|don't|never|avoid|\bnot)\s+(?:use\s+)?([a-z0-9._+-]+)/g)) {
    negative.add(match[1]);
  }
  for (const match of normalized.matchAll(/(?:必须)?(?:使用|采用|用)\s*([a-z0-9._+-]+)/g)) {
    positive.add(match[1]);
  }
  for (const match of normalized.matchAll(/(?:不要|不用|不再|禁止|避免)(?:使用|用)?\s*([a-z0-9._+-]+)/g)) {
    negative.add(match[1]);
  }
  return { positive, negative };
}

function askPolarity(text) {
  const value = String(text || "").normalize("NFKC").toLowerCase();
  if (
    /(?:never|do not|don't|without)\s+(?:ask|confirm)/.test(value) ||
    /(?:不要|无需|不需要).{0,8}(?:问|询问|确认)/u.test(value)
  ) {
    return "negative";
  }
  if (
    /(?:always|must)\s+(?:ask|confirm)|(?:ask|confirm)\s+before/.test(value) ||
    /(?:必须|都要|先).{0,8}(?:问|询问|确认)/u.test(value)
  ) {
    return "positive";
  }
  return null;
}

function polarityClauses(text) {
  const scopeOnlyUnits = new Set([
    "private",
    "workspace",
    "project",
    "repo",
    "repository",
    "global",
    "session",
    "task",
    "turn",
    "current",
  ]);
  return String(text || "")
    .split(/(?:[.!?。！？；;,，\n]|\b(?:but|however)\b|但是|不过)/iu)
    .map((value) => value.normalize("NFKC").trim())
    .filter(Boolean)
    .map((raw) => {
      const negative =
        /(?:\bnever\b|\bno\b|\bnot\b|\bdon't\b|\bdo\s+not\b|\bmust\s+not\b|\bwithout\b|\bavoid\b|\bomit\b|\bexclude\b|\bskip\b|\brefuse\b|\bban\b|\bdisable\b|\bremove\b|\breject\b|\bdrop\b|\bforbid\b|\bsuppress\b|\bdelete\b|\bstop\b|\bclose\b|\bhide\b|\bturn\s+off\b|\bignore\b|\bdisregard\b|\berase\b|\bclear\b|\bdiscard\b|\bstrip\b|\bpurge\b|\bwipe\b|\brevoke\b|\bblock\b|\bdeny\b|\bprevent\b|\bdeprecate\b|不要|不得|禁止|不再|不接受|无需|不需要|避免|别|不能|禁用|停用|移除|拒绝|弃用|去掉|关闭|取消|删除|停止|屏蔽|抑制|隐藏|忽略|清空|擦除|丢弃|阻止|废弃|关掉|去除)/iu.test(
          raw,
        );
      const core = raw
        .toLowerCase()
        .replace(
          /\b(?:always|never|must|should|please|from\s+now\s+on|in\s+the\s+future|do\s+not|don't|not|no|without|avoid|omit|exclude|skip|refuse|ban|disable|remove|reject|drop|forbid|suppress|delete|stop|close|hide|turn\s+off|ignore|disregard|erase|clear|discard|strip|purge|wipe|revoke|block|deny|prevent|deprecate)\b/giu,
          " ",
        )
        .replace(/(?:以后|从今以后|总是|始终|每次|都要|必须|应该|请|不要|不得|禁止|不再|不接受|无需|不需要|避免|别|不能|禁用|停用|移除|拒绝|弃用|去掉|关闭|取消|删除|停止|屏蔽|抑制|隐藏|忽略|清空|擦除|丢弃|阻止|废弃|关掉|去除)/gu, " ");
      return { raw, polarity: negative ? "negative" : "positive", units: contentUnits(core) };
    })
    .filter(
      (entry) =>
        entry.units.size > 0 &&
        ![...entry.units].every((unit) => scopeOnlyUnits.has(unit)),
    );
}

function overlapRatio(left, right) {
  let intersection = 0;
  for (const unit of left) {
    if (right.has(unit)) intersection += 1;
  }
  return intersection / Math.max(1, Math.min(left.size, right.size));
}

export function findPolarityReversal(evidenceText, proposalText) {
  const evidenceClauses = polarityClauses(evidenceText);
  const proposalClauses = polarityClauses(proposalText);
  for (const candidate of proposalClauses) {
    for (const source of evidenceClauses) {
      const overlap = overlapRatio(source.units, candidate.units);
      if (source.polarity !== candidate.polarity && overlap >= 0.6) {
        return {
          evidence_clause: source.raw,
          proposal_clause: candidate.raw,
          lexical_overlap: Number(overlap.toFixed(3)),
          evidence_polarity: source.polarity,
          proposal_polarity: candidate.polarity,
        };
      }
    }
  }
  return null;
}

function checkRelationReversal(evidence, proposal) {
  const evidenceText = evidence.map((item) => item.text).join("\n");
  const proposalText = semanticClauses(proposal).join("\n");
  const evidenceUse = collectUseRelations(evidenceText);
  const proposalUse = collectUseRelations(proposalText);
  const reversedTerms = [
    ...[...proposalUse.positive].filter((term) => evidenceUse.negative.has(term)),
    ...[...proposalUse.negative].filter((term) => evidenceUse.positive.has(term)),
  ];
  const evidenceAsk = askPolarity(evidenceText);
  const proposalAsk = askPolarity(proposalText);
  const genericReversal = findPolarityReversal(evidenceText, proposalText);
  if (
    reversedTerms.length > 0 ||
    (evidenceAsk && proposalAsk && evidenceAsk !== proposalAsk) ||
    genericReversal
  ) {
    return issue(
      ERROR_CODES.POLARITY_REVERSAL,
      "Proposal reverses a supported preference relation or confirmation policy.",
      {
        reversed_terms: [...new Set(reversedTerms)],
        evidence_ask_polarity: evidenceAsk,
        proposal_ask_polarity: proposalAsk,
        generic_reversal: genericReversal,
      },
    );
  }
  return null;
}

function maximumDurabilityForEvidence(evidence, input) {
  const strength = evidenceStrength(evidence, input);
  if (strength <= 0) return "observation";
  if (strength <= 1) return "candidate";
  if (strength <= 3) return "trial";
  if (strength <= 7) return "active";
  return "permanent";
}

function checkScope(evidence, proposal) {
  const supportingScopes = evidence
    .map((item) => String(item.scope || "").toLowerCase())
    .filter((scope) => scopeSupports(scope, proposal.scope));
  if (supportingScopes.length === 0) {
    const evidenceScopes = [...new Set(evidence.map((item) => item.scope))];
    return issue(
      ERROR_CODES.SCOPE_WIDENING,
      `Proposal scope '${proposal.scope}' is not supported by evidence scopes ${evidenceScopes.join(", ")}.`,
      {
        evidence_scopes: evidenceScopes,
        proposal_scope: proposal.scope,
        suggested_scope: evidenceScopes[0],
      },
    );
  }
  return null;
}

function checkAmbiguity(evidence, proposal) {
  const ambiguous = evidence.filter((item) =>
    AMBIGUOUS_EVIDENCE_KINDS.has(String(item.kind || "").toLowerCase()),
  );
  const hasExplicit = evidence.some(
    (item) =>
      item.explicit_persistence ||
      EXPLICIT_EVIDENCE_KINDS.has(String(item.kind || "").toLowerCase()),
  );
  if (ambiguous.length > 0 && !hasExplicit) {
    return issue(
      ERROR_CODES.AMBIGUOUS_REWARD,
      "Ambiguous feedback cannot justify a persistent behavioral rule.",
      {
        evidence_kinds: ambiguous.map((item) => item.kind),
        supported_durability: "observation",
      },
    );
  }
  return null;
}

function checkDurability(evidence, proposal, input) {
  const maximum = maximumDurabilityForEvidence(evidence, input);
  if (
    rank(DURABILITY_ORDER, normalizeDurability(proposal.durability)) >
    rank(DURABILITY_ORDER, maximum)
  ) {
    return issue(
      ERROR_CODES.INSUFFICIENT_EVIDENCE,
      `Evidence supports durability '${maximum}', not '${proposal.durability}'.`,
      {
        supported_durability: maximum,
        proposal_durability: proposal.durability,
        evidence_count: evidence.length,
      },
    );
  }
  return null;
}

function checkOneOff(evidence, proposal) {
  const hasExplicitDurableSupport = evidence.some((item) => {
    const kind = String(item.kind || "").toLowerCase();
    return (
      (item.explicit_persistence === true && hasPersistenceCue(item.text)) ||
      kind === "explicit_remember"
    );
  });
  const oneOff = !hasExplicitDurableSupport && evidence.some((item) => {
    const kind = String(item.kind || "").toLowerCase();
    const narrowUnpersisted =
      item.explicit_persistence !== true &&
      ["turn", "session", "task"].includes(String(item.scope || "").toLowerCase());
    return ONE_OFF_EVIDENCE_KINDS.has(kind) || narrowUnpersisted;
  });
  const positiveExternalMutation =
    !hasNegativePolarity(proposal.content) &&
    /(?:\b(?:push|publish|deploy|send)\b|完成后推送|推送到.{0,20}(?:仓库|github)|发布到|部署到)/iu.test(
      String(proposal.content || ""),
    );
  const narrowScope = ["turn", "session", "task"].includes(
    String(proposal.scope || "").toLowerCase(),
  );
  const overDurableTransientScope =
    narrowScope &&
    rank(DURABILITY_ORDER, normalizeDurability(proposal.durability)) >
      rank(DURABILITY_ORDER, "candidate");
  if (
    (oneOff ||
      overDurableTransientScope ||
      (positiveExternalMutation &&
        !evidence.some((item) => hasTemporalPersistenceCue(item.text)))) &&
    rank(DURABILITY_ORDER, normalizeDurability(proposal.durability)) >
      rank(DURABILITY_ORDER, "observation")
  ) {
    return issue(
      ERROR_CODES.ONE_OFF_AS_PERSISTENT,
      "A one-off instruction cannot be promoted into durable agent configuration.",
      { supported_durability: overDurableTransientScope ? "candidate" : "observation" },
    );
  }
  return null;
}

function hasNegativePolarity(text) {
  const normalized = normalizeText(text);
  const cjkNegative = ["禁止", "不要", "不得", "不再", "没有", "没按", "完全没"];
  return (
    cjkNegative.some((token) => normalized.includes(token)) ||
    /(^|\s)(not|never|no|without|avoid)(\s|$)/u.test(normalized)
  );
}

function checkMixedOrSarcastic(evidence, proposal) {
  for (const item of evidence) {
    const kind = String(item.kind || "").toLowerCase();
    if (kind === "sarcasm") {
      return issue(
        ERROR_CODES.MIXED_OR_SARCASTIC_FEEDBACK,
        "Sarcastic feedback cannot be treated as literal positive evidence.",
        { evidence_kind: kind },
      );
    }
    if (kind !== "mixed_feedback") continue;
    const raw = String(item.text || "");
    const parts = raw.split(/(?:\bbut\b|\bhowever\b|不过|但是|但|就是)/iu);
    const decisiveClause = parts.at(-1) || raw;
    if (
      hasNegativePolarity(decisiveClause) &&
      !hasNegativePolarity(proposal.content)
    ) {
      return issue(
        ERROR_CODES.MIXED_OR_SARCASTIC_FEEDBACK,
        "Proposal reverses or ignores the corrective clause in mixed feedback.",
        { decisive_clause: decisiveClause.trim() },
      );
    }
  }
  return null;
}

function checkDestination(evidence, proposal, input) {
  const target = normalizeTarget(proposal.target);
  const durability = rank(DURABILITY_ORDER, normalizeDurability(proposal.durability));
  const explicitPersistence = evidence.some(
    (item) => item.explicit_persistence || item.kind === "explicit_remember",
  );
  const proposalScope = String(proposal.scope || "").toLowerCase();

  if (
    ["policy", "rule"].includes(target) &&
    ["turn", "session", "task"].includes(proposalScope)
  ) {
    return issue(
      ERROR_CODES.WRONG_DESTINATION,
      "A durable instruction file outlives a turn, session, or task; keep this instruction in transient task state.",
      { target: proposal.target, proposal_scope: proposal.scope, suggested_target: "memory" },
    );
  }

  if (target === "policy" && durability < rank(DURABILITY_ORDER, "active")) {
    return issue(
      ERROR_CODES.WRONG_DESTINATION,
      "Global or project policy files require an active, sufficiently supported rule.",
      { target: proposal.target, suggested_target: "memory" },
    );
  }

  if (target === "policy" && !explicitPersistence) {
    return issue(
      ERROR_CODES.WRONG_DESTINATION,
      "A policy-file change requires explicit persistence intent or user confirmation.",
      { target: proposal.target, suggested_target: "memory" },
    );
  }

  if (target === "skill") {
    const procedure = proposal.procedure || {
      trigger: proposal.trigger,
      steps: proposal.steps,
      success_criteria: proposal.success_criteria,
    };
    const hasProcedure =
      procedure &&
      typeof procedure === "object" &&
      String(procedure.trigger || "").trim() &&
      Array.isArray(procedure.steps) &&
      procedure.steps.length > 0 &&
      (Array.isArray(procedure.success_criteria)
        ? procedure.success_criteria.length > 0
        : String(procedure.success_criteria || "").trim());
    if (!hasProcedure) {
      return issue(
        ERROR_CODES.SKILL_LACKS_PROCEDURE,
        "A skill proposal requires trigger, non-empty steps, and success criteria.",
        { target: proposal.target, suggested_target: "memory" },
      );
    }
  }

  const evidenceKinds = new Set(
    evidence.map((item) => String(item.kind || "").toLowerCase()),
  );
  if (evidenceKinds.has("factual_statement") && target !== "memory") {
    return issue(
      ERROR_CODES.WRONG_DESTINATION,
      "A factual statement belongs in memory, not a behavioral policy or procedure.",
      { target: proposal.target, suggested_target: "memory" },
    );
  }
  if (evidenceKinds.has("procedure_request") && target !== "skill") {
    return issue(
      ERROR_CODES.WRONG_DESTINATION,
      "A reusable procedure belongs in a skill with an explicit trigger and acceptance criteria.",
      { target: proposal.target, suggested_target: "skill" },
    );
  }
  if (target === "skill" && evidenceKinds.has("explicit_preference")) {
    return issue(
      ERROR_CODES.WRONG_DESTINATION,
      "A behavioral preference is not a reusable multi-step procedure.",
      { target: proposal.target, suggested_target: "agent.md" },
    );
  }
  if (
    target === "memory" &&
    evidenceKinds.has("explicit_preference") &&
    /(?:必须|不得|禁止|先问|ask before|must|never|always)/iu.test(proposal.content)
  ) {
    return issue(
      ERROR_CODES.WRONG_DESTINATION,
      "An enforceable behavioral policy belongs in agent instructions or a scoped rule.",
      { target: proposal.target, suggested_target: "agent.md" },
    );
  }

  return null;
}

function checkProcedureEvidence(proposal) {
  if (normalizeTarget(proposal.target) !== "skill") return null;
  const steps = asArray(proposal.procedure?.steps ?? proposal.steps);
  const trigger = proposal.procedure?.trigger ?? proposal.trigger;
  const criteria = asArray(
    proposal.procedure?.success_criteria ?? proposal.success_criteria,
  );
  if (!String(trigger || "").trim() || steps.length === 0 || criteria.length === 0) {
    return issue(
      ERROR_CODES.INSUFFICIENT_EVIDENCE,
      "The proposal does not contain enough procedural detail to justify a reusable skill.",
      { required: ["trigger", "steps", "success_criteria"] },
    );
  }
  return null;
}

function artifactConflicts(artifact, proposal) {
  if (!artifact || artifact.status === "retired") return false;
  const existing = normalizeText(artifact.content);
  const candidate = normalizeText(proposal.content);
  if (artifact.key && proposal.key && artifact.key === proposal.key) {
    return normalizeText(artifact.value ?? artifact.content) !== normalizeText(proposal.value ?? proposal.content);
  }
  if (!existing || !candidate || existing === candidate) return false;
  const negationPairs = [
    ["always ", "never "],
    ["must ", "must not "],
    ["use ", "do not use "],
    ["prefer ", "avoid "],
    ["总是", "不要"],
    ["必须", "禁止"],
    ["使用", "不要使用"],
    ["优先", "避免"],
    ["禁止", "允许"],
    ["ask before", "without asking"],
    ["先询问", "无需询问"],
    ["简洁", "详细"],
    ["concise", "detailed"],
  ];
  return negationPairs.some(
    ([positive, negative]) =>
      (existing.includes(positive) && candidate.includes(negative)) ||
      (existing.includes(negative) && candidate.includes(positive)),
  );
}

export function hasReplacementCue(evidence) {
  return asArray(evidence).some((item) =>
    /(?:改用|改成|不再|替换|取代|更新为|replace|switch|instead|supersede|from now on use)/iu.test(
      String(item?.text || ""),
    ),
  );
}

function scopesOverlap(left, right) {
  const a = String(left || "").toLowerCase();
  const b = String(right || "").toLowerCase();
  return (
    a === b ||
    (SCOPE_COVERAGE[a] || []).includes(b) ||
    (SCOPE_COVERAGE[b] || []).includes(a)
  );
}

function textsRelated(left, right) {
  const leftUnits = contentUnits(left);
  const rightUnits = contentUnits(right);
  if (leftUnits.size === 0 || rightUnits.size === 0) return false;
  return overlapRatio(leftUnits, rightUnits) >= 0.5;
}

function checkConflicts(input) {
  const proposal = input.proposal;
  const artifacts = asArray(input.current?.artifacts);
  const replacementLanguage = hasReplacementCue(input.evidence);
  const replacements = new Set([
    ...asArray(proposal.supersedes),
    ...(proposal.replaces ? [proposal.replaces] : []),
  ]);
  const evidenceText = asArray(input.evidence).map((item) => item?.text || "").join("\n");
  const conflicts = artifacts.filter((artifact) => {
    if (
      replacementLanguage &&
      (replacements.has(artifact.id) || replacements.has(artifact.key))
    ) {
      return false;
    }
    return (
      scopesOverlap(artifact.scope, proposal.scope) &&
      normalizeTarget(artifact.target) === normalizeTarget(proposal.target) &&
      (
        artifactConflicts(artifact, proposal) ||
        (
          replacementLanguage &&
          !replacements.has(artifact.id) &&
          !replacements.has(artifact.key) &&
          textsRelated(evidenceText, artifact.content ?? artifact.value)
        )
      )
    );
  });
  if (conflicts.length > 0) {
    return issue(
      ERROR_CODES.CONFLICT,
      "Proposal conflicts with an active artifact in the same target and scope.",
      {
        conflicts: conflicts.map((artifact) => artifact.id || artifact.key || artifact.content),
      },
    );
  }
  return null;
}

export function checkProposal(input) {
  const validationIssues = validateInput(input);
  if (validationIssues.length > 0) {
    return {
      decision: DECISIONS.BLOCK,
      issues: validationIssues,
      summary: "Invalid learning proposal.",
    };
  }

  const evidence = deduplicateEvidence(asArray(input.evidence));
  const proposal = input.proposal;
  const issues = [
    checkScope(evidence, proposal),
    checkAmbiguity(evidence, proposal),
    checkMixedOrSarcastic(evidence, proposal),
    checkRelationReversal(evidence, proposal),
    checkLexicalSupport(evidence, proposal),
    checkDurability(evidence, proposal, input),
    checkOneOff(evidence, proposal),
    checkDestination(evidence, proposal, input),
    checkProcedureEvidence(proposal),
    checkConflicts(input),
  ].filter(Boolean);

  const hasHardBlock = issues.some((entry) => BLOCKING_CODES.has(entry.code));
  const decision =
    issues.length === 0
      ? DECISIONS.PASS
      : hasHardBlock
        ? DECISIONS.BLOCK
        : DECISIONS.ABSTAIN;

  return {
    decision,
    issues,
    summary:
      decision === DECISIONS.PASS
        ? "Proposal is supported by the supplied evidence and scope."
        : decision === DECISIONS.BLOCK
          ? "Proposal must not be persisted in its current form."
          : "Proposal needs more evidence or explicit user clarification.",
    normalized: {
      target: normalizeTarget(proposal.target),
      evidence_scopes: [...new Set(evidence.map((item) => item.scope))],
      maximum_durability: maximumDurabilityForEvidence(evidence, input),
    },
  };
}

export function formatResult(result, format = "text") {
  if (format === "json") return `${JSON.stringify(result, null, 2)}\n`;
  const lines = [`agent-learning-gate: ${result.decision}`, "", result.summary];
  for (const entry of result.issues || []) {
    lines.push("", entry.code, entry.message);
    if (Object.keys(entry.details || {}).length > 0) {
      lines.push(JSON.stringify(entry.details, null, 2));
    }
  }
  return `${lines.join("\n")}\n`;
}
