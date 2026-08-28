---
name: agent-learning-gate
description: Guard durable coding-agent learning with evidence-backed proposals. Use when Claude Code, Codex, Cursor, Pi, or another coding agent is about to persist a user preference, correction, instruction, memory, rule, or skill beyond the current task.
---

# Agent Learning Gate

Treat durable learning as a proposed policy change. Do not infer a lasting preference merely because the user praised, criticized, or corrected one response.

## Host route

Identify the active host before routing the proposal:

- `claude-code`: native `Write`/`Edit` Hook can force an exact interactive prompt.
- `pi`: extension blocks `write`/single `edit` and presents a deny-first TUI/RPC choice.
- `codex`: review one exact add/append `apply_patch`, present it, and stop; the Hook denies protected Agent patches.
- `cursor`: review one exact `Write`/`Edit`, present it, and stop; the Hook denies protected Agent writes.
- `generic`: run `check` and `review` only unless an independently trusted adapter is installed.

Read [references/hosts.md](references/hosts.md) only when host-specific operation shape, approval behavior, or limitations matter.

## Proposal workflow

Resolve the CLI from `AGENT_LEARNING_GATE_CLI` or `PATH` and keep proposal evidence outside the repository:

```bash
CLI="${AGENT_LEARNING_GATE_CLI:-agent-learning-gate}"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-${CURSOR_PROJECT_DIR:-$PWD}}"
PROPOSAL_DIR="$($CLI proposal-dir --project-dir "$PROJECT_DIR")"
```

If `agent-learning-gate` is not on `PATH`, resolve `../../bin/agent-learning-gate` from this installed Skill directory (the plugin root is two levels above `skills/agent-learning-gate`). Do not inspect engine source to discover the workflow. If neither path is executable, stop and report the missing shared CLI instead of placing proposals in the repository.

Create one JSON proposal at `$PROPOSAL_DIR/<id>.json`. Include:

- exact user evidence, source turn, evidence kind, and behavioral scope;
- relevant active/trial artifacts and explicit replacement references;
- the smallest supported lesson, target, scope, durability, and install scope;
- one exact host operation in `proposal.operation`.

Never invent evidence, broaden text-scoped intent through metadata, reverse polarity, add an unsupported clause, or treat `user_confirmation.confirmed` as authority.

Run:

```bash
"$CLI" check "$PROPOSAL_DIR/<id>.json"
"$CLI" review "$PROPOSAL_DIR/<id>.json" --project-dir "$PROJECT_DIR" --host <host>
```

Treat the returned review receipt as non-authorizing evidence. Present its digest, exact target, validated delta, and exact operation; do not paraphrase the reviewed mutation.

On `BLOCK` or `ABSTAIN`, do not persist. Continue observing or ask one concise question only when the answer changes the durable behavior.

## Confirmation boundary

- For `claude-code` and `pi`, run `stage` after `review`, then issue the exact staged operation once. The host adapter asks the user at the operation boundary.
- For `codex` and `cursor`, never run `stage` or retry the denied write. Show the exact lesson, target, receipt digest, and diff, then leave application to the user outside the Agent. After an external application, run `"$CLI" verify <receipt-path>` and report `VERIFIED`, `NOT_APPLIED`, or `DRIFTED` exactly.
- For `generic`, do not claim enforcement or approval.

Any path, content, patch, or preimage change requires a new review; on Claude Code and Pi, any session, TTL, or digest change also requires a new staged approval. One staged permit authorizes one matching operation. Do not bypass a denial with shell, PowerShell, MCP, another extension, a different path, or an external process.

When replacing an existing lesson, require explicit replacement language, name the active/trial same-target artifact in `replaces` or `supersedes`, and bind the exact old and new content. Codex v0 intentionally denies replacement patches; use a separate reviewed workflow rather than weakening the patch gate.

Agent Learning Gate is a cooperative harness guard, not an operating-system sandbox. If the active host adapter is absent, disabled, untrusted, or unsupported, report that boundary and leave the durable change unapplied.
