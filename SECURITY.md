# Security model

Agent Learning Gate is a host-neutral proposal checker plus capability-graded coding-agent adapters. It reduces accidental or model-generated durable-learning writes that lack evidence, scope, destination fit, exact operation binding, or a supported approval signal.

It is not an operating-system sandbox, authentication boundary, or complete monitor of every filesystem mutation path.

## Shared invariants

Before a supported durable write, Agent Learning Gate binds:

- the proposal digest and exact operation fingerprint;
- canonical target path and install scope;
- target preimage and expected postimage;
- host adapter, project, session when available, and expiry for staged native permits;
- one atomic consumption.

Changed paths, content, patches, sessions, preimages observed at permit consumption, replay, symlink retargeting, unsupported replacements, and cross-host permits are rejected on supported paths. Review receipts include the exact operation and validated delta, are explicitly non-authorizing, and can verify the final postimage after an external application. A small TOCTOU window remains between the final Hook/extension check and the host's actual filesystem write.

## Host guarantees

### Claude Code

The `PreToolUse` Hook can return native `permissionDecision: ask`. The permit is consumed before the prompt. Launcher failure, missing Node, timeout, disabled Hooks, and changes while the prompt is open remain outside an atomic transaction. Headless modes have no terminal approval UI.

### Codex

Codex `PreToolUse` can deny `apply_patch`, but current Codex does not support `ask`; returning it marks the Hook failed and continues the tool call. Agent Learning Gate therefore uses explicit deny only. `agent-learning-gate review` can validate a one-file Add File or explicit-EOF append proposal, but no Codex permit is issued and the Agent must not apply it.

Plugin Hooks must be reviewed and trusted. Hook errors, timeout, disabled Hooks, managed policy that excludes plugin Hooks, or specialized tool paths may fail open. `UserPromptSubmit` is not used as approval because the Hook executable and its inputs are reachable from the Agent process.

Codex project Hook discovery follows the invocation workspace. A resumed task launched from a different directory can receive a different project Hook set; Agent Learning Gate therefore requires installation as a user/plugin Hook or same-workspace resume and treats cwd drift as outside the project-Hook boundary.

### Cursor

Cursor `preToolUse` with `failClosed: true` blocks native Agent `Write`/`Edit`/`Delete`. Generic pre-tool `ask` is not currently enforced, and caller-prompt Hooks are not treated as a trusted approval boundary. `agent-learning-gate review` validates the exact operation but creates no permit. Cursor Tab has no pre-edit blocking Hook. User Rules and native Memories are not intercepted. Local user plugins are not automatically present in Cursor Cloud agents.

### Pi

The Pi extension blocks built-in `write` and one-item `edit` through the pre-execution `tool_call` event. It consumes the permit, then presents a deny-first TUI/RPC selection with canonical path, a bounded preview, and the bound digest. Print/json mode denies because no UI exists. RPC selections may be supplied by automation rather than a human, and a digest-bound 500-character preview does not prove the caller read all long content. Later extensions share the process and direct filesystem code remains outside the boundary.

## Common gaps

- Direct shell, PowerShell, Python, Node, MCP, IDE, and other-process writes are not comprehensively intercepted.
- Codex and Cursor have no in-Agent approval or apply path in v0; a reviewed proposal must be applied through an external user-controlled workflow, then checked with `agent-learning-gate verify`.
- A user or process controlling the same account can alter Hook configuration, extension code, permits, or target files.
- Hardlinks, specialized tools, unknown native memories, imported instruction files, and host-specific fallback filenames may require explicit extra destinations.
- Codex background Memories, Cursor native Memories/User Rules, and Pi extension-managed memory stores are explicitly outside v0 coverage; only documented file-based destinations are claimed.
- Durable configuration usually affects a later agent session; it is not retroactively inserted into the current model context.
- Natural-language checks are conservative heuristics, not semantic proof.
- State cleanup is manual. Proposal evidence, review receipts, and consumed permits remain private but persist under `~/.agent-learning-gate` until removed.

Review receipt digests detect accidental or unsynchronized edits; they are not signatures. A process controlling the same account can rewrite both the receipt and displayed digest.

For hard organizational policy, combine managed Hooks, host permissions, sandboxing, code review, and CI in a boundary the Agent cannot modify.

## Privacy

The core and bundled adapters make no network requests. Proposal state can contain exact user words. The optional history extractor is best-effort redaction, not declassification; never publish its output without manual review.

## Reporting

Report minimal synthetic reproductions. Do not attach conversation transcripts, credentials, private paths, proposal state, or user memory to a public issue.
