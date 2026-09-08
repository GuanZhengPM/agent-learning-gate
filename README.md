# Agent Learning Gate

[简体中文](#简体中文) | [English](#english)

<a id="简体中文"></a>

## 简体中文

### 项目简介

Agent Learning Gate 管两件事：Coding Agent **不该记住什么**，以及**不该忘掉什么**。

- **学习门禁**：审查 Agent 准备写入长期记忆、规则或 Skill 的内容。它检查证据、作用域、目标位置、持久性、冲突和具体写入操作，避免把随口反馈、一次性命令或局部纠正固化成长期指令。
- **决策账本**：强制 Agent 把被否决的方案、失败的尝试和用户划的边界记进 `DECISIONS.md`，并在每个新会话开始时注入，避免下一个会话把已经枪毙的方案再做一遍。

```text
与宿主无关的核心
  学习门禁：证据 + 作用域 + 目标位置 + 持久性 + 冲突 + 精确操作绑定
  决策账本：追加式 DECISIONS.md + 开工注入 + 收工强制记录
        |
        +-- Claude Code adapter
        +-- Codex adapter
        +-- Cursor adapter
        +-- Pi extension（仅学习门禁）
        `-- generic CLI / CI adapter
```

学习门禁：Agent 提交变更建议，确定性核心返回 `PASS`、`BLOCK` 或 `ABSTAIN`，宿主适配器再按照当前宿主提供的授权能力处理写入。决策账本：Hook 在会话开始时把有效条目注入上下文，在会话做过修改后拦住第一次结束，要求 Agent 用 CLI 记录否决或明确声明没有。

### 能力矩阵

| 宿主 | 写入前拦截 | 授权边界 | v0 写入支持 | 账本注入 | 账本强制写入 |
|---|---:|---|---|---:|---:|
| Claude Code | yes | 原生精确 `ask` | 单次 `Write` 或 `Edit` | yes | yes |
| Codex | yes | Agent 内无可验证授权通道 | 审查精确 patch，阻止受保护的 `apply_patch` | yes | yes |
| Cursor | yes | Agent 内无可验证授权通道 | 审查精确写入，阻止受保护的 `Write`/`Edit` | yes | no，CLI 打印模式不触发 `stop` |
| Pi | yes | 默认拒绝的 TUI/RPC 选择 | 单次 `write` 或单项 edit | no | no |
| Generic | no | none | `check`、`review`、`verify`、`benchmark`、`ledger` | 手动 `ledger render` | no |

Codex 当前不支持可靠的 Hook `ask`：返回 `ask` 会使 Hook 失败，工具调用仍可能继续。Cursor 的通用 pre-tool `ask` 也没有形成可验证的授权边界。v0 对 Codex 和 Cursor 采用明确拒绝；Claude Code 和 Pi 可以在操作边界展示原生确认界面。

宿主协议：[Claude Code Hooks](https://code.claude.com/docs/en/hooks)、[Codex Hooks](https://learn.chatgpt.com/docs/hooks)、[Cursor Hooks](https://cursor.com/docs/hooks)。Pi 的验证依据为 Pi 0.84.3 内置的 `docs/extensions.md` 和 `docs/packages.md`。

测试快照：

| 接口 | 学习门禁（2026-08-28） | 决策账本 Hook（2026-09-08） |
|---|---|---|
| Claude Code | strict plugin validator 2.1.250 | 2.1.237，含 `-p` 无人值守模式 |
| Codex CLI | 0.146.0 | 0.153.4，含 `codex exec` |
| Cursor Agent | 2026.08.25-3e8eec8 | 2026.09.02-c22c1a3，仅注入 |
| Pi | 0.84.3 | 不适用 |

Hook 协议会随版本变化。升级后请重新执行后文的 smoke check，再确认相应行为仍然成立。

### 使用流程

含义不清的反馈不会直接形成规则：

```text
User: Nice work.
Agent proposal: Always use tables.
Agent Learning Gate: ABSTAIN E401_AMBIGUOUS_REWARD
Result: nothing is persisted
```

Claude Code 和 Pi 使用单轮确认：

```text
User: Remember that this repository uses uv run pytest.
Agent: check -> stage exact operation
Host: show exact Write/Edit confirmation
User: Deny / Allow once
```

Codex 和 Cursor 使用审查与冻结流程：

```text
Agent: check -> review exact operation
Agent Learning Gate: PASS REVIEWED + non-authorizing receipt + exact diff
Agent: show lesson + target + receipt digest + exact diff and stop
User: applies, edits, or rejects the change outside the Agent
User/Agent: agent-learning-gate verify <receipt.json>
```

`check` 检查学习内容。`review` 进一步绑定目标文件、写入前后内容和精确操作，并生成 `authorizes_write: false` 的私有回执。外部或人工完成写入后，`verify` 用于核对结果是否与回执一致。`stage` 仅供 Claude Code 和 Pi 使用；它只负责暂存操作，授权仍由宿主界面完成。`user_confirmation.confirmed` 字段不会被当作授权依据。

### 从本地仓库安装

要求：Node.js 18+，以及需要接入的 Agent。

如需从 Shell 或外部工作流直接调用，可安装共享 CLI。宿主 Skill 在未找到全局 CLI 时会使用插件内置版本。

```bash
cd /absolute/path/to/agent-learning-gate
npm install -g .
agent-learning-gate capabilities
```

#### Claude Code

```bash
claude plugin marketplace add /absolute/path/to/agent-learning-gate
claude plugin install agent-learning-gate@agent-learning-gate --scope user
```

重启 Claude Code 并检查 `/hooks`。插件使用 `hooks/claude-hooks.json`。

Smoke check：运行 `claude plugin list`，确认 `agent-learning-gate@agent-learning-gate` 已安装；随后在一次性测试项目中请求精确写入 `CLAUDE.md`。未暂存的请求应被拒绝；完成 review 和 stage 后，精确写入应触发原生权限确认。

#### Codex

```bash
codex plugin marketplace add /absolute/path/to/agent-learning-gate
codex plugin add agent-learning-gate@agent-learning-gate
```

启动新任务，打开 `/hooks`，审查并信任当前 Agent Learning Gate Hook。Codex 会跳过未受信任的插件 Hook。受保护的 patch 会被明确拒绝，Agent 可以先展示已审查的建议和精确 diff。

任务应在同一保存的 workspace 中启动和恢复。插件 Hook 保持全局安装，但当前工作目录会影响项目作用域判断和回执中的项目哈希。

Smoke check：运行 `codex plugin list`，确认版本并检查 `/hooks`；然后在一次性项目中请求受保护的 patch。patch 应被拒绝，目标文件应保持不存在。

#### Cursor

本地开发：

```bash
cursor-agent --plugin-dir /absolute/path/to/agent-learning-gate/plugins/agent-learning-gate
```

Cursor CLI 当前可以管理 Marketplace，但没有本地 `plugin install` 命令。发布后的安装入口为 Cursor Customize/Marketplace，本地插件清单位于 `.cursor-plugin/plugin.json`。

Cursor v0 适配器会阻止对受保护位置的 Agent 写入。它可以审查并展示精确建议，写入需由外部流程完成。Cursor Tab、原生 Memories 和 User Rules 不在该 Hook 路径的覆盖范围内。

Smoke check：使用 `--plugin-dir` 启动 Cursor Agent，在一次性项目中请求写入受保护的 `AGENTS.md`，确认 Hook 拒绝且文件未生成。`--force` 不应覆盖这次明确拒绝。测试 IDE Marketplace 时，还需单独确认插件出现在 Cursor Customize 中。

#### Pi

```bash
pi install /absolute/path/to/agent-learning-gate
```

项目级 Pi 配置使用 `-l`。print/json 模式没有交互式授权界面，因此受保护的持久化写入会被拒绝。

Smoke check：运行 `pi list`，重启 Pi，然后执行 `/agent-learning-gate`。TUI 应显示 `agent-learning-gate: active` 和内置 CLI 路径。未暂存的受保护写入应被拦截。

### CLI

```bash
agent-learning-gate check proposal.json --format json
agent-learning-gate review proposal.json --project-dir "$PWD" --host codex
agent-learning-gate review proposal.json --project-dir "$PWD" --host cursor
agent-learning-gate verify /path/from/review-receipt.json
agent-learning-gate stage proposal.json --project-dir "$PWD" --host claude-code
agent-learning-gate stage proposal.json --project-dir "$PWD" --host pi
agent-learning-gate capabilities cursor --format json
agent-learning-gate benchmark benchmark/wrong-lessons-v0.jsonl
agent-learning-gate ledger init
agent-learning-gate ledger add --kind rejected --title "..." --why "..." --source tool
agent-learning-gate ledger none --reason "..."
agent-learning-gate ledger list --format json
```

| 结果 | 退出码 | 含义 |
|---|---:|---|
| `PASS` | 0 | 验证通过；该结果不授予写权限。Claude/Pi 仍需原生确认，Codex/Cursor 需外部写入后执行 `verify`。 |
| `BLOCK` | 2 | 存在明确违规，建议不能持久化。 |
| `ABSTAIN` | 3 | 证据不足或含义不清。 |
| Invalid input | 4 | 输入不符合协议。 |

机器可读协议见 [proposal.schema.json](plugins/agent-learning-gate/schemas/proposal.schema.json)。宿主操作示例见 [host adapter reference](plugins/agent-learning-gate/skills/agent-learning-gate/references/hosts.md)。

### 受保护的持久化位置

共享分类器覆盖常见的文件型指令、规则和 Skill 路径：

- `AGENTS.md`、`AGENTS.override.md`、`CLAUDE.md`、`CLAUDE.local.md`、`AGENT.md`；
- Claude rules、skills、project auto-memory 和 agent memory；
- Cursor `.cursor/rules`、`.cursorrules` 和受支持的 Skill 根目录；
- Codex/Cursor 共享的 `.agents/skills` 及兼容 Skill 根目录；
- Pi `.pi/SYSTEM.md`、`.pi/APPEND_SYSTEM.md` 和 Skill 根目录；
- 通过 `AGENT_LEARNING_GATE_EXTRA_DESTINATIONS` 声明的类型化位置。

运行时 permit 和不授权写入的 review receipt 默认存放在 consumer repository 之外的 `~/.agent-learning-gate/projects/<hash>/`。可以使用 `AGENT_LEARNING_GATE_STATE_DIR` 更改位置。

Claude project auto-memory 有文档化文件路径，因此可以纳入保护。Codex background Memories、Cursor native Memories/User Rules 和 Pi extension-managed memories 目前无法通过这些文件工具适配器拦截。

### 决策账本

Agent 自己写的交接材料（压缩摘要、记忆文件、子 Agent 汇报）系统性地记录"做到哪了、下一步做什么"，却漏掉"什么已经被否决、为什么"。下一个会话读不到否决信息，就会把被枪毙的方案再做一遍。决策账本把这类否定性信息变成一份强制维护的文件：

- `DECISIONS.md` 是项目内的追加式记录，只收四类条目：`rejected`（试过并被否的方案）、`failed`（已知原因失败的尝试）、`veto`（用户明确说不要）、`constraint`（用户设定的边界）；要撤销一条，追加一条 `superseded`，不删旧条目。
- 会话开始时，Hook 把当前有效条目注入上下文，要求 Agent 把它们当作既定决定，与新请求冲突时先说明再动手。
- 会话做过修改或跑过命令后，Stop Hook 会拦截一次结束，要求 Agent 逐条 `ledger add`，或者用 `ledger none --reason` 明确声明本次没有新的否决。写入由 Hook 强制，不靠模型自觉。

账本按项目选择启用：只有 `DECISIONS.md` 存在（或设置 `AGENT_LEARNING_GATE_LEDGER=on`）时 Hook 才生效；`AGENT_LEARNING_GATE_LEDGER_ENFORCE=0` 可以只注入、不拦截。

```bash
agent-learning-gate ledger init
agent-learning-gate ledger add --kind rejected --title "parse_dates 用正则实现" --why "issue #42：本地化输入下静默接受非法月份" --source tool
agent-learning-gate ledger add --kind constraint --title "不要修改 config/" --why "另一个团队负责" --source user
agent-learning-gate ledger none --reason "纯重命名，没有否决任何方案"
agent-learning-gate ledger list
```

触发点：Claude Code 和 Codex 在 `SessionStart`、`UserPromptSubmit` 注入，在 `Stop` 强制；Cursor 只在 `sessionStart` 注入。Codex 的项目级 Hook 需要在 `/hooks` 里信任，或在自动化中传 `--dangerously-bypass-hook-trust`。

DECISIONS.md 是给下一个会话看的，所以放在项目根目录、随仓库提交；不想入库时用 `AGENT_LEARNING_GATE_LEDGER_FILE` 改路径。

### 交接探针

`benchmark/handoff-probe/` 用真实的 Claude Code、Codex、Cursor CLI 做一个可重复的两阶段实验：先在任务里埋入一条工具可见的否决和一条用户约束，通过"继续同一会话 / 新会话 / 委托子 Agent"三种渠道交接，再引诱下一个会话复活被否决的方案，用程序检查它有没有上钩，并对比账本开关的效果。使用订阅制 CLI，不需要 API key。

```bash
npm run handoff-probe -- --host claude,codex,cursor --channel fresh --ledger off,on --repeat 5
npm run handoff-probe:summary
```

设计、检查项和各宿主的限制见 [benchmark/handoff-probe/README.md](benchmark/handoff-probe/README.md)。单次试验不说明任何问题；结论只对当时的 CLI 版本和模型成立。

### 评测

```bash
npm ci
npm run validate
npx -y node@18 scripts/run-tests.mjs
npx -y @anthropic-ai/claude-code@2.1.250 plugin validate . --strict
```

`WrongLessons-v0` 包含 54 个中英双语结构化策略用例，用于回归测试。它不衡量原始反馈抽取准确率。决策账本有独立的单元测试；交接探针的结果和基于本地对话的实验数据都保存在 gitignored `.agent-learning-gate/` 中，即使经过尽力脱敏，也应按敏感数据处理。

测试运行器会先清掉宿主注入的会话、项目和状态环境变量，再启动 `node --test`，因此在 Claude Code、Codex 或 Cursor 会话里跑测试与在 CI 里结果一致。

### 安全边界

Agent Learning Gate 是 Coding Agent 工作流中的协作式防护层，不提供操作系统级隔离。Shell、PowerShell、MCP、外部进程、禁用或未受信任的 Hook、同账号状态篡改以及宿主特有工具路径都可能绕过不完整的适配器。Cursor Tab 和原生 Cursor Memories 也不在覆盖范围内。Codex 和 Cursor v0 只负责审查与拒绝，写入需在 Agent 外完成。

在组织环境中使用前，请阅读 [SECURITY.md](SECURITY.md)。

项目源代码公开托管于 GitHub，尚未发布到 npm、Cursor Marketplace 或公共 Pi package registry。

### 许可证

Apache-2.0

[返回顶部](#agent-learning-gate)

---

<a id="english"></a>

## English

### Overview

Agent Learning Gate governs two things: what a coding agent **must not remember**, and what it **must not forget**.

- **Learning gate**: reviews content before the agent writes it to long-lived memory, rules, or skills. It checks evidence, scope, destination, durability, conflicts, and the exact write operation so that casual feedback, one-off commands, and local corrections do not become unsupported persistent instructions.
- **Decision ledger**: forces the agent to record rejected options, failed attempts, and user-set boundaries in `DECISIONS.md`, and injects them at the start of every session so the next session does not revive work that was already ruled out.

```text
host-neutral core
  learning gate:   evidence + scope + destination + durability + conflict + exact-operation binding
  decision ledger: append-only DECISIONS.md + inject at session start + enforced write at stop
        |
        +-- Claude Code adapter
        +-- Codex adapter
        +-- Cursor adapter
        +-- Pi extension (learning gate only)
        `-- generic CLI / CI adapter
```

Learning gate: the agent submits a proposed change, the deterministic core returns `PASS`, `BLOCK`, or `ABSTAIN`, and the host adapter handles the write using the approval boundary available on that host. Decision ledger: Hooks inject the active entries when a session starts and, once the session has changed something, block its first attempt to finish until the agent records the session's rejections through the CLI or states that there are none.

### Capability matrix

| Host | Pre-write block | Approval boundary | v0 mutation support | Ledger injection | Ledger enforced write |
|---|---:|---|---|---:|---:|
| Claude Code | yes | native exact `ask` | one `Write` or `Edit` | yes | yes |
| Codex | yes | no verified in-Agent approval channel | review exact patch and deny protected `apply_patch` | yes | yes |
| Cursor | yes | no verified in-Agent approval channel | review exact write and deny protected `Write`/`Edit` | yes | no; the CLI print mode never fires `stop` |
| Pi | yes | deny-first TUI/RPC selection | one `write` or single edit | no | no |
| Generic | no | none | `check`, `review`, `verify`, `benchmark`, and `ledger` | manual `ledger render` | no |

Codex currently has no reliable Hook `ask` path: returning `ask` can fail the Hook while the tool call continues. Cursor's generic pre-tool `ask` also lacks a verified approval boundary. Version 0 uses explicit denial for Codex and Cursor. Claude Code and Pi can present native confirmation at the operation boundary.

Host contracts: [Claude Code Hooks](https://code.claude.com/docs/en/hooks), [Codex Hooks](https://learn.chatgpt.com/docs/hooks), and [Cursor Hooks](https://cursor.com/docs/hooks). Pi validation uses the bundled `docs/extensions.md` and `docs/packages.md` from Pi 0.84.3.

Tested snapshot:

| Surface | Learning gate (2026-08-28) | Decision-ledger Hooks (2026-09-08) |
|---|---|---|
| Claude Code | strict plugin validator 2.1.250 | 2.1.237, including unattended `-p` mode |
| Codex CLI | 0.146.0 | 0.153.4, including `codex exec` |
| Cursor Agent | 2026.08.25-3e8eec8 | 2026.09.02-c22c1a3, injection only |
| Pi | 0.84.3 | not applicable |

Hook contracts are version-sensitive. After an upgrade, rerun the smoke checks below before relying on the documented behavior.

### Workflow

Ambiguous feedback does not become a rule:

```text
User: Nice work.
Agent proposal: Always use tables.
Agent Learning Gate: ABSTAIN E401_AMBIGUOUS_REWARD
Result: nothing is persisted
```

Claude Code and Pi use one-turn confirmation:

```text
User: Remember that this repository uses uv run pytest.
Agent: check -> stage exact operation
Host: show exact Write/Edit confirmation
User: Deny / Allow once
```

Codex and Cursor use a review-and-freeze flow:

```text
Agent: check -> review exact operation
Agent Learning Gate: PASS REVIEWED + non-authorizing receipt + exact diff
Agent: show lesson + target + receipt digest + exact diff and stop
User: applies, edits, or rejects the change outside the Agent
User/Agent: agent-learning-gate verify <receipt.json>
```

`check` validates the proposed lesson. `review` also binds the target, preimage, postimage, and exact operation, then creates a private receipt with `authorizes_write: false`. After an external or manual write, `verify` checks the result against that receipt. `stage` is available for Claude Code and Pi and only stages the operation; approval still happens in the host UI. The checker ignores `user_confirmation.confirmed` as an authorization signal.

### Install from a local repository

Requirements: Node.js 18+ and the target agent.

Install the shared CLI for direct shell or external-workflow use. Host skills fall back to the bundled binary when no global CLI is available.

```bash
cd /absolute/path/to/agent-learning-gate
npm install -g .
agent-learning-gate capabilities
```

#### Claude Code

```bash
claude plugin marketplace add /absolute/path/to/agent-learning-gate
claude plugin install agent-learning-gate@agent-learning-gate --scope user
```

Restart Claude Code and inspect `/hooks`. The plugin uses `hooks/claude-hooks.json`.

Smoke check: run `claude plugin list` and confirm `agent-learning-gate@agent-learning-gate`. In a disposable project, request an exact `CLAUDE.md` write. An unstaged request should be denied. A reviewed and staged exact write should open the native permission prompt.

#### Codex

```bash
codex plugin marketplace add /absolute/path/to/agent-learning-gate
codex plugin add agent-learning-gate@agent-learning-gate
```

Start a new task, open `/hooks`, and review and trust the current Agent Learning Gate Hook. Codex skips untrusted plugin Hooks. Protected patches receive an explicit denial after the agent has had a chance to present the reviewed proposal and exact diff.

Start and resume the task from the same saved workspace. The plugin Hook remains globally installed, while the current working directory affects project-scope classification and the project hash stored in review receipts.

Smoke check: run `codex plugin list`, confirm the installed version, and inspect `/hooks`. Then request a protected patch in a disposable project. The patch should be denied and the target file should remain absent.

#### Cursor

For local development:

```bash
cursor-agent --plugin-dir /absolute/path/to/agent-learning-gate/plugins/agent-learning-gate
```

The Cursor CLI currently supports marketplace management without a local `plugin install` command. Published installation goes through Cursor Customize/Marketplace. The local plugin manifest is `.cursor-plugin/plugin.json`.

The Cursor v0 adapter denies agent writes to protected locations. It can review and present an exact proposal; application must happen through an external workflow. Cursor Tab, native Memories, and User Rules are outside this Hook path.

Smoke check: launch Cursor Agent with `--plugin-dir`, request a protected `AGENTS.md` write in a disposable project, and confirm that the Hook denies it and the file remains absent. `--force` should not override the explicit denial. For IDE marketplace testing, separately confirm that the plugin appears in Cursor Customize.

#### Pi

```bash
pi install /absolute/path/to/agent-learning-gate
```

Use `-l` for project-local Pi settings. Print/json mode has no interactive approval UI, so protected durable writes are denied.

Smoke check: run `pi list`, restart Pi, and use `/agent-learning-gate`. The TUI should show `agent-learning-gate: active` and the bundled CLI path. An unstaged protected write should be blocked.

### CLI

```bash
agent-learning-gate check proposal.json --format json
agent-learning-gate review proposal.json --project-dir "$PWD" --host codex
agent-learning-gate review proposal.json --project-dir "$PWD" --host cursor
agent-learning-gate verify /path/from/review-receipt.json
agent-learning-gate stage proposal.json --project-dir "$PWD" --host claude-code
agent-learning-gate stage proposal.json --project-dir "$PWD" --host pi
agent-learning-gate capabilities cursor --format json
agent-learning-gate benchmark benchmark/wrong-lessons-v0.jsonl
agent-learning-gate ledger init
agent-learning-gate ledger add --kind rejected --title "..." --why "..." --source tool
agent-learning-gate ledger none --reason "..."
agent-learning-gate ledger list --format json
```

| Decision | Exit | Meaning |
|---|---:|---|
| `PASS` | 0 | Validation passed; no write permission is granted. Claude/Pi still require native approval. Codex/Cursor require external application followed by `verify`. |
| `BLOCK` | 2 | A hard violation blocks persistence. |
| `ABSTAIN` | 3 | Evidence is insufficient or ambiguous. |
| Invalid input | 4 | Input does not match the protocol. |

See [proposal.schema.json](plugins/agent-learning-gate/schemas/proposal.schema.json) for the machine-readable contract and the [host adapter reference](plugins/agent-learning-gate/skills/agent-learning-gate/references/hosts.md) for host-specific operation examples.

### Protected durable surfaces

The shared classifier covers common file-based instruction, rule, and skill paths:

- `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `CLAUDE.local.md`, and `AGENT.md`;
- Claude rules, skills, project auto-memory, and agent memory;
- Cursor `.cursor/rules`, `.cursorrules`, and supported skill roots;
- shared and compatible Codex/Cursor `.agents/skills` roots;
- Pi `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`, and skill roots;
- typed destinations declared through `AGENT_LEARNING_GATE_EXTRA_DESTINATIONS`.

Runtime permits and non-authorizing review receipts are stored outside consumer repositories under `~/.agent-learning-gate/projects/<hash>/` by default. Use `AGENT_LEARNING_GATE_STATE_DIR` to move them.

Claude project auto-memory has a documented file path and is covered. Codex background Memories, Cursor native Memories/User Rules, and Pi extension-managed memories cannot currently be intercepted through these file-tool adapters.

### Decision ledger

Agent-authored handoff material (compaction summaries, memory files, subagent reports) reliably records progress and plans while dropping negative decisions: what was tried and rejected, and why. The next session cannot see a rejection it was never handed, so it revives the work. The decision ledger turns that class of information into a file the agent is required to maintain:

- `DECISIONS.md` is an append-only project record with four entry kinds: `rejected` (tried and ruled out), `failed` (an attempt with a known cause), `veto` (the user said no), and `constraint` (a boundary the user set). Retire an entry by appending a `superseded` entry; nothing is deleted.
- At session start a Hook injects the active entries and asks the agent to treat them as settled, and to say so before acting on a request that conflicts with one.
- Once a session has edited files or run commands, the Stop Hook blocks the first attempt to finish until the agent either records entries with `ledger add` or states explicitly with `ledger none --reason` that there is nothing to add. The write is enforced by the Hook, not left to the model's judgement.

The ledger is opt-in per project: the Hooks are inert until `DECISIONS.md` exists (or `AGENT_LEARNING_GATE_LEDGER=on`). Set `AGENT_LEARNING_GATE_LEDGER_ENFORCE=0` to inject without blocking.

```bash
agent-learning-gate ledger init
agent-learning-gate ledger add --kind rejected --title "Regex-based parse_dates" --why "issue #42: silently accepted malformed months on locale input" --source tool
agent-learning-gate ledger add --kind constraint --title "Do not modify config/" --why "owned by another team" --source user
agent-learning-gate ledger none --reason "pure rename, nothing was ruled out"
agent-learning-gate ledger list
```

Trigger points: Claude Code and Codex inject on `SessionStart` and `UserPromptSubmit` and enforce on `Stop`; Cursor injects on `sessionStart` only. Codex project-level Hooks must be trusted in `/hooks`, or run with `--dangerously-bypass-hook-trust` in automation.

`DECISIONS.md` exists for the next session, so it lives at the project root and is meant to be committed; point `AGENT_LEARNING_GATE_LEDGER_FILE` elsewhere if it must stay out of the repository.

### Handoff probe

`benchmark/handoff-probe/` is a repeatable two-phase experiment on the real Claude Code, Codex, and Cursor CLIs. It plants a tool-visible rejection and a user constraint, hands the project over through one of three channels (resume the session, start a fresh session, delegate to a subagent), tempts the next session to revive the rejected work, checks programmatically whether it did, and compares the ledger on and off. It runs on the CLIs' own subscriptions; no API key is needed.

```bash
npm run handoff-probe -- --host claude,codex,cursor --channel fresh --ledger off,on --repeat 5
npm run handoff-probe:summary
```

Design, checks, and per-host limitations are in [benchmark/handoff-probe/README.md](benchmark/handoff-probe/README.md). A single trial proves nothing; results describe one CLI version and model at a time.

### Evaluation

```bash
npm ci
npm run validate
npx -y node@18 scripts/run-tests.mjs
npx -y @anthropic-ai/claude-code@2.1.250 plugin validate . --strict
```

`WrongLessons-v0` contains 54 bilingual structured-policy cases for regression testing. It does not measure raw-feedback extraction accuracy. The decision ledger has its own unit tests. Handoff-probe results and experiments derived from local conversations stay under the gitignored `.agent-learning-gate/` directory and should be treated as sensitive even after best-effort redaction.

The test runner scrubs host-injected session, project, and state variables before spawning `node --test`, so running the suite inside a Claude Code, Codex, or Cursor session gives the same result as CI.

### Security boundary

Agent Learning Gate is a cooperative guard within a coding-agent workflow and does not provide operating-system isolation. Shell, PowerShell, MCP, external processes, disabled or untrusted Hooks, same-account state tampering, and host-specific tool paths can bypass an incomplete adapter. Cursor Tab and native Cursor Memories are also outside the covered surface. Codex and Cursor v0 provide review and denial; application happens outside the agent.

Read [SECURITY.md](SECURITY.md) before using Agent Learning Gate as an organizational control.

The source repository is publicly available on GitHub. It has not been published to npm, the Cursor Marketplace, or a public Pi package registry.

### License

Apache-2.0

[Back to top](#agent-learning-gate)
