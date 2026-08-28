# Host adapter reference

## Capability matrix

| Host | Blocking surface | Approval signal | Supported v0 mutation |
|---|---|---|---|
| Claude Code | `PreToolUse` | native `permissionDecision: ask` | one exact `Write` or `Edit` |
| Codex | `PreToolUse` | none inside Agent v0 | review add/end-append patch; deny protected mutation |
| Cursor | `preToolUse` | none inside Agent v0 | review exact `Write`/`Edit`; deny protected mutation |
| Pi | extension `tool_call` | deny-first `ctx.ui.select` | one exact `write` or single edit |
| Generic | none | none | check/review/benchmark only |

## Operation shapes

Write proposal sidecars only under the directory returned by `agent-learning-gate proposal-dir`; never create `.staging`, `.agent-learning-gate`, or proposal JSON inside the consumer repository.

Minimal Cursor example:

```json
{
  "evidence": {
    "text": "Create AGENTS.md with exactly this rule: Use uv run pytest.",
    "role": "user",
    "kind": "explicit_instruction",
    "scope": "workspace",
    "explicit_persistence": true
  },
  "current": { "active_scope": "workspace", "artifacts": [] },
  "proposal": {
    "target": "AGENTS.md",
    "content": "Use uv run pytest.",
    "scope": "workspace",
    "durability": "stable",
    "operation": {
      "tool": "Write",
      "adapter": "cursor",
      "file_path": "/absolute/project/AGENTS.md",
      "content": "Use uv run pytest.\n"
    }
  }
}
```

Claude Code and Cursor:

```json
{
  "tool": "Write",
  "file_path": "/absolute/path/AGENTS.md",
  "content": "Exact resulting content\n",
  "adapter": "cursor"
}
```

Use `adapter: "claude-code"` for Claude. For `Edit`, use `old_string`, `new_string`, and `replace_all`.

Pi proposals use the same canonical `Write`/`Edit` fields with `adapter: "pi"`. The extension maps Pi's `{path, content}` and one-item `{path, edits:[{oldText,newText}]}` payloads into this shape.

Codex binds the complete patch command:

```json
{
  "tool": "apply_patch",
  "adapter": "codex",
  "command": "*** Begin Patch\n*** Add File: AGENTS.md\n+Exact content\n*** End Patch"
}
```

Codex v0 reviews exactly one protected target and only Add File or a one-hunk append anchored at the current end of file. Delete, move, replacement, removal, multi-file, and unanchored patches are denied.

## Approval semantics

Claude Code's native prompt is interactive only. Pi denies in print/json mode because no UI is available.

Codex and Cursor do not currently provide a verified approval channel on these adapter paths. Agent Learning Gate deliberately does not mint permits from caller-prompt events: the Agent can invoke the same Hook executable and supply forged input. `review` binds the current project, target, preimage, postimage, validated delta, and exact operation in a non-authorizing receipt. Application happens outside the Agent, and `verify` checks the resulting file against that receipt.

## Coverage exclusions

- Shell, PowerShell, MCP, external processes, and same-account state tampering remain outside complete enforcement.
- Cursor Tab has no pre-edit blocking Hook, and native Cursor Memories/User Rules are not covered.
- Codex plugin Hooks require explicit trust; `ask` is unsupported and must never be emitted by the Codex adapter.
- Pi extensions share one process. A later hostile extension or direct filesystem call is outside the boundary.
- Durable instruction files are generally reloaded by a later session, not retroactively injected into the current model context.
