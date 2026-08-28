# Agent Learning Gate host bundle

This directory is the installable Claude Code, Codex, Cursor, and Pi host bundle for Agent Learning Gate.

- Shared Skill: `skills/agent-learning-gate/SKILL.md`
- Claude Hook: `hooks/claude-hooks.json`
- Codex Hooks: `hooks/hooks.json`
- Cursor Hooks: `hooks/cursor-hooks.json`
- Pi extension: `extensions/agent-learning-gate.js`
- Shared CLI and core: `bin/` and `lib/`

The Skill resolves the bundled `bin/agent-learning-gate` when no global CLI is present. Install the standalone CLI on `PATH` only when users or external workflows need to run review/verify directly: from the repository root, run `npm install -g .`. Only Claude Code and Pi support permit staging in v0.

See the repository-level README for complete installation, capability grades, tests, and limitations. This bundle is a cooperative correctness gate, not an operating-system sandbox.
