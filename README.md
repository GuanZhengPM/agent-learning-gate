# Agent Learning Gate

> Governance gateway for coding agent learning, rules, and decision memory.  
> 面向 Coding Agent 的规则演进与长期记忆治理网关：管控规则写入依据，防止一次性反馈固化为全局规则；维护决策账本，避免跨会话重复尝试已否决的方案。

[简体中文](#简体中文) · [English](#english)

---

<a id="简体中文"></a>

## 简体中文

### 背景与解决的问题

在长期使用 Claude Code、Codex、Cursor 等 Coding Agent 时，Agent 的自主学习与记忆持久化通常面临两个矛盾的工程问题：

1. **规则过度固化（False Learning）**：用户在单次对话中针对具体场景给出的临时修正或随口反馈，容易被 Agent 误判为通用准则并写入 `CLAUDE.md`、`.cursorrules` 或全局 Memory，导致后续所有无关联任务都被带偏；
2. **负向经验丢失（Repeated Failures）**：开发过程中被明确否决的方案、已验证不可行的路径（Negative Examples），在开启新会话后丢失上下文，导致新会话中的 Agent 反复提出相同的错误方案。

Agent Learning Gate 通过两套机制治理 Agent 的学习链路：
* **学习门禁**：对写入长期记忆、规则与 Skill 的操作进行依据与作用域审查；
* **决策账本**：在项目根目录维护结构化的 `DECISIONS.md`，正向偏好与负向经验均保留，开工自动注入上下文。

### 架构设计

```text
宿主适配器 (Host Adapters)
  Claude Code Hook · Codex Plugin · Cursor Agent · Pi Extension · 通用 CLI
                     │
                     ▼
与宿主解耦的规则引擎 (Core Engine)
  ├─ 学习门禁：依据充分性 + 项目作用域 + 目标位置 + 潜在冲突 → [PASS / BLOCK / ABSTAIN]
  └─ 决策账本：追加式 DECISIONS.md + 新会话上下文注入 + 结束前强制记录检查
```

### 核心能力

#### 1. 学习门禁 (Learning Gate)
Agent 试图调用工具修改受保护的规则文件时触发拦截：
* **充分性检验**：排除含义模糊的褒扬（如用户输入“干得漂亮”，拒绝持久化为全局规则）或单次局部 workaround；
* **作用域匹配**：检查规则内容是否仅适用于当前单一子模块，若是则阻止写入全局规则；
* **操作绑定与回执**：通过精确的 diff 和操作哈希绑定改动，在宿主支持时触发原生权限确认（如 Claude Code），在无交互权限通道的宿主中明确拦截并输出已审查回执（如 Codex / Cursor）。

#### 2. 决策账本 (Decision Ledger)
* **负向方案保留**：将确认不可行的技术方案、已淘汰的依赖库与用户声明的边界写入 `DECISIONS.md`；
* **会话启动注入**：新会话通过 Hook 自动将历史决策加载至上下文前置提示中，明确告知 Agent“哪些方案已被排除，请勿再次尝试”；
* **收工强制检查**：对产生过代码变更但未登记决策的会话进行拦截，督促记录本次尝试的取舍结论。

### 宿主支持矩阵

| 宿主 | 写入前拦截 | 授权方式 | 账本新会话注入 | 账本结束前检查 |
| :--- | :---: | :--- | :---: | :---: |
| **Claude Code** | 是 | 原生精确 `ask` 确认弹窗 | 是 | 是 |
| **Codex** | 是 | 拦截受保护 patch，输出待审建议与 diff | 是 | 是 |
| **Cursor** | 是 | 拦截受保护写入，输出待审建议与 diff | 是 | 否（CLI 模式无 stop hook） |
| **Pi** | 是 | TUI 原生选择菜单 | 否 | 否 |
| **Generic CLI / CI** | 否（手动调用） | 命令行 `agent-learning-gate` | 手动 `ledger render` | 否 |

### 快速开始

#### 安装全局 CLI

要求：Node.js 18+

```bash
cd /path/to/agent-learning-gate
npm install -g .
agent-learning-gate capabilities
```

#### 接入主流宿主

##### 1. Claude Code

```bash
claude plugin marketplace add /path/to/agent-learning-gate
claude plugin install agent-learning-gate@agent-learning-gate --scope user
```
*重启 Claude Code 并运行 `/hooks`，确认插件加载成功。*

##### 2. Codex

```bash
codex plugin marketplace add /path/to/agent-learning-gate
codex plugin add agent-learning-gate@agent-learning-gate
```
*在 `/hooks` 中审查并信任当前插件 Hook。*

### 命令行常用指令

```bash
# 审查一份学习建议提案（返回 PASS / BLOCK / ABSTAIN）
agent-learning-gate check proposal.json --format json

# 绑定项目目录与具体宿主生成待审回执
agent-learning-gate review proposal.json --project-dir "$PWD" --host codex

# 核对外部写入是否与回执严格一致
agent-learning-gate verify review-receipt.json

# 初始化决策账本
agent-learning-gate ledger init

# 记录一项被否决的方案
agent-learning-gate ledger add \
  --kind rejected \
  --title "使用全量重构替代增量修补" \
  --why "破坏既有公共 API 兼容性，已被单元测试证伪" \
  --source tool

# 查看当前生效的决策记录
agent-learning-gate ledger list --format json
```

### 受保护的目标路径

门禁分类器覆盖各工具常见的全局与项目级指令文件：
* `CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/`
* `AGENTS.md`, `AGENT.md`, `.agents/skills/`
* `.cursorrules`, `.cursor/rules/`

### License

[Apache-2.0](LICENSE)

---

<a id="english"></a>

## English

### Overview

Agent Learning Gate governs how coding agents acquire long-term knowledge. It addresses two core challenges:

1. **Rule Overfitting**: Validates evidence and scope before writing to persistent instructions (e.g., `CLAUDE.md`, `.cursorrules`), preventing transient user feedback from turning into unintended global directives.
2. **Negative Experience Retention**: Preserves discarded approaches and user-rejected paths in an append-only `DECISIONS.md`, injecting them into new sessions so agents do not repeatedly retry failed solutions.

### Problem Statement & Background

When working with coding agents over extended timelines (Claude Code, Codex, Cursor), persistent agent memory introduces two conflicting failure modes:

1. **Rule Overfitting (False Learning)**: Casual user corrections or temporary workarounds in a single session are frequently generalized by the agent and written into `CLAUDE.md`, `.cursorrules`, or global memory files, contaminating all subsequent unrelated sessions.
2. **Loss of Negative Experience (Repeated Failures)**: Approaches explicitly rejected by the user or invalidated by unit tests are forgotten once a session ends, leading agents in new sessions to repeatedly propose the exact same dead ends.

Agent Learning Gate provides two coordinated mechanisms to govern this lifecycle:
* **Learning Gate**: Audits proposed modifications to persistent rules, memories, and skills for empirical evidence and project scope.
* **Decision Ledger**: Maintains an append-only `DECISIONS.md` file in the project root, preserving both positive constraints and rejected negative approaches, injected automatically into every new session.

### Architecture

```text
Host Adapters
  Claude Code Hook · Codex Plugin · Cursor Agent · Pi Extension · Generic CLI
                     │
                     ▼
Host-Decoupled Policy Engine
  ├─ Learning Gate: Evidence Sufficiency + Project Scope + Target Path + Conflict Check → [PASS / BLOCK / ABSTAIN]
  └─ Decision Ledger: Append-only DECISIONS.md + Session Context Injection + Exit Verification Hook
```

### Core Capabilities

#### 1. Learning Gate
Intercepts tool invocations attempting to modify protected instruction files:
* **Sufficiency Check**: Filters out ambiguous praise (e.g., user says "great job", rejecting persistent rule creation) or one-off local hacks.
* **Scope Matching**: Validates whether a proposed guideline applies only to a sub-package before allowing writes to global configuration.
* **Operation Binding & Receipts**: Binds exact diffs and content hashes to non-authorizing receipts. Prompts native UI confirmations where supported (Claude Code) or blocks unverified direct writes while outputting review receipts (Codex, Cursor).

#### 2. Decision Ledger
* **Negative Approach Retention**: Logs invalidated technical routes, discarded dependencies, and user-defined constraints into `DECISIONS.md`.
* **New Session Injection**: Injects past decisions into the agent's initial prompt context via startup hooks, warning the model in advance of ruled-out solutions.
* **Pre-Exit Verification**: Intercepts the first session conclusion attempt if code modifications occurred without corresponding decision tracking.

### Host Compatibility Matrix

| Host | Pre-Write Interception | Authorization Channel | Ledger Session Injection | Ledger Exit Enforcement |
| :--- | :---: | :--- | :---: | :---: |
| **Claude Code** | Yes | Native precise `ask` dialog | Yes | Yes |
| **Codex** | Yes | Blocks protected patch; outputs review diff | Yes | Yes |
| **Cursor** | Yes | Blocks protected write; outputs review diff | Yes | No (CLI mode lacks stop hook) |
| **Pi** | Yes | Native TUI selection menu | No | No |
| **Generic CLI / CI** | No (manual) | Command-line `agent-learning-gate` | Manual `ledger render` | No |

### Quick Start

#### Install Global CLI

Requirements: Node.js 18+

```bash
cd /path/to/agent-learning-gate
npm install -g .
agent-learning-gate capabilities
```

#### Connect to Hosts

##### 1. Claude Code

```bash
claude plugin marketplace add /path/to/agent-learning-gate
claude plugin install agent-learning-gate@agent-learning-gate --scope user
```
*Restart Claude Code and run `/hooks` to verify installation.*

##### 2. Codex

```bash
codex plugin marketplace add /path/to/agent-learning-gate
codex plugin add agent-learning-gate@agent-learning-gate
```
*Review and trust the hook under `/hooks`.*

### Common CLI Commands

```bash
# Evaluate a learning proposal (returns PASS / BLOCK / ABSTAIN)
agent-learning-gate check proposal.json --format json

# Bind target directory and host to generate a review receipt
agent-learning-gate review proposal.json --project-dir "$PWD" --host codex

# Verify external manual write strictly matches the review receipt
agent-learning-gate verify review-receipt.json

# Initialize project decision ledger
agent-learning-gate ledger init

# Record an explicitly rejected approach
agent-learning-gate ledger add \
  --kind rejected \
  --title "Replace incremental parser with full AST rebuild" \
  --why "Violates backward API compatibility; falsified by unit tests" \
  --source tool

# List active decisions in structured JSON
agent-learning-gate ledger list --format json
```

### Protected Target Paths

Covers common instruction and rule paths across IDEs and agents:
* `CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/`
* `AGENTS.md`, `AGENT.md`, `.agents/skills/`
* `.cursorrules`, `.cursor/rules/`

### License

[Apache-2.0](LICENSE)
