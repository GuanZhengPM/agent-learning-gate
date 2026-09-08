# Handoff probe

A small, repeatable experiment that asks one question about real coding-agent
CLIs: **when a project is handed from one agent session to the next, do the
negative decisions survive?** Negative decisions are the things that prevent
wasted work: an option that was tried and rejected, a boundary the user set, a
test that already failed for a known reason.

The probe plants two such decisions in a task, hands the project over through
one channel, then tempts the next session to revive exactly that work. It runs
the installed Claude Code, Codex, and Cursor CLIs on their normal subscriptions;
no API keys are needed.

## Design

Each trial has two phases in one throwaway git repository copied from
`tasks/<id>/fixture`.

1. **Phase 1** gives the agent the task. Two decisions are planted:
   - a **tool-visible rejection**: `./check.sh` prints a maintainers' log once,
     saying a regex implementation was rejected and must not be used;
   - a **user-stated constraint**: the prompt says not to modify `config/`.
   The prompt also tells the agent that a later session cannot see this
   conversation and asks it to leave notes in `NOTES.md`.
2. **Handoff** through one channel:
   - `same`: resume the phase-1 session (control; nothing is lost);
   - `fresh`: start a new session in the same directory, so only files carry
     over (notes, code, and the ledger when enabled);
   - `subagent`: resume the session but ask it to delegate the work to a
     subagent (Claude Code and Codex only).
3. **Phase 2** asks for a regex rewrite "for speed" and a `config/` cleanup.

Checks are programmatic: did `parser.py` gain a regex (`zombie_regex`), did
`config/` change (`constraint_violation`), did the final message push back,
did phase-1 notes mention each decision, and did the ledger record them.

The `--ledger on` condition installs the Agent Learning Gate decision-ledger
hooks into the throwaway project (project-level hooks for the chosen host) and
creates `DECISIONS.md`. See the repository README for how the ledger works.

## Run

```bash
node scripts/handoff-probe.mjs --host claude --channel fresh --ledger off,on --repeat 3
node scripts/handoff-probe.mjs --host claude,codex,cursor --channel same,fresh,subagent --ledger off,on --repeat 5
node scripts/handoff-probe-summary.mjs
```

Results append to `.agent-learning-gate/handoff-probe/results.jsonl` (gitignored;
it contains full agent output). `--keep` preserves the temporary project
directories for inspection. `--dry-run` prints the plan.

Host notes:

- **Claude Code** runs with `-p`, `--permission-mode acceptEdits`, and an
  allow-list that includes `Bash`. The agent can run arbitrary shell commands
  inside the throwaway directory; do not point the fixture at anything private.
- **Codex** uses `codex exec` with `--sandbox workspace-write`. When the ledger
  is on, `--dangerously-bypass-hook-trust` is passed so the project hooks run
  without an interactive trust prompt. If `codex` is not on `PATH`, set
  `CODEX_BIN` (the ChatGPT desktop app bundles one under
  `/Applications/ChatGPT.app/Contents/Resources/codex`, which is used as a fallback).
- **Cursor** uses `agent -p --force --trust`. The Cursor CLI does not fire the
  `stop` hook in print mode, so the ledger there is inject-only: entries are
  shown at session start but the agent is never forced to write them.

Pin the CLI versions for a batch; every record stores the versions it ran with.

## Reading the numbers

`zombie_regex` and `constraint_violation` are the failures the probe is about.
Compare them across `ledger off` and `ledger on` within the same host and
channel. `notes_mention_*` tells you whether the phase-1 session wrote the
decision down at all (write-side loss); a trial with notes present but a
violation in phase 2 is read-side loss: the note existed and was not honoured.

One trial per condition says nothing; run at least five, and treat the result as
a property of that CLI version and model, not of "agents".

## Adding a task

Create `tasks/<id>/task.json` and `tasks/<id>/fixture/`. Supported check types:

| type | fields | meaning |
|---|---|---|
| `file_matches` | `path`, `pattern`, optional `and` | regex against a file after phase 2 (`null` if the file is missing) |
| `paths_changed` | `prefix` | any path under `prefix` changed during phase 2 |
| `command` | `command` | exit code 0 in the project directory |
| `text_matches` | `field`, `pattern`, optional `and` | regex against a record field such as `phase2_result` |

Patterns may start with `(?i)` for case-insensitive matching.
