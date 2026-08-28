# Installed bundle security boundary

Agent Learning Gate intercepts only the normal mutation tools documented for each host. It does not comprehensively intercept shell, PowerShell, MCP, external processes, disabled/untrusted Hooks, same-account state tampering, Cursor Tab, or undocumented native memory systems.

Claude Code and Pi use host UI at the operation boundary. Codex and Cursor are deny-only in v0: they can create a non-authorizing review receipt and verify a later external application, but they issue no write permit. Codex `ask`, Cursor generic pre-tool `ask`, and Agent-visible caller prompts are not treated as trusted approval channels.

Review and trust extension/Hook source before enabling it. See the repository-level `SECURITY.md` for the full host-by-host model and reporting guidance.
