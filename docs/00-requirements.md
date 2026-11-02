# 00 · 需求与范围

> 状态：已冻结  
> 日期：2026-11-03  
> 本文是 agent-shell 的需求基线。实现顺序见 [02-roadmap.md](./02-roadmap.md)，技术方案见 [01-architecture.md](./01-architecture.md)，验收见 [04-testing-and-acceptance.md](./04-testing-and-acceptance.md)。

## 1. 一句话定义

agent-shell 是一个**本地优先、无业务绑定**的 agent 运行时外壳：把模型、工具、子 agent、审批、会话和可观测性组装成可复用的内核；业务能力通过配置、代码工具、插件和 MCP 注入，核心代码不包含任何业务逻辑。

## 2. 背景与目标

- **G1 可扩展**：Provider、工具、子 agent 编排、审批策略、事件出口都可替换或组合；新增能力不修改核心循环。
- **G2 可观察**：每次运行产出结构化事件流，能回放“模型说了什么、调了什么工具、谁批准了、子 agent 花了多少”。
- **G3 可验证**：用一条无业务参考场景（本地文件助手）贯穿全部能力，离线可重复验收。
- **G4 可维护**：阶段化实现、契约冻结、ADR 记录、开发规范写入 `AGENT.md`。

关于最初“看到 agent 怎样一步一步搭起来”的目标，最终决策是**架构优先**：

- 实现仍按阶段推进，并保留阶段文档与验收记录；
- 但不为了展示内部循环而放弃 LangGraph；
- 运行时的“看见”由事件流和 trace 回放承担，见 ADR-0001、ADR-0006。

## 3. 非目标（v1 明确不做）

- **不做具体业务**：核心不包含文件、搜索、邮件、数据库等业务工具；本地文件助手只作为 `examples/file-agent/` 参考场景。
- **不做 Web UI / TUI / 远程服务**：v1 只有 CLI REPL 与命令；不做 HTTP API、多用户、鉴权、租户。
- **不做长期语义记忆 / RAG / 向量库**：只做会话持久化（短期记忆）。
- **不做插件沙箱**：插件同进程加载，信任本地代码；隔离留待后续版本。
- **不做插件热重载、插件市场、依赖解析**。
- **不做多机部署、任务队列、分布式执行**。
- **不保证 Windows 一等公民**：v1 以 macOS / Linux 为准。
- **不做 token 级 trace 回放**：默认不落 token delta。
- **不做模型训练、微调、评测平台**。

## 4. 目标用户与使用方式

**主要用户**：需要在本地快速组装 agent 的开发者。通过 `agent-shell.config.ts` 组合 Provider、工具、agent 和预设，用 CLI 运行。

**次要用户**：插件作者。通过 `@agent-shell/core/plugin` 的 `definePlugin` / `defineTool` 提供工具。

**典型使用方式**：

1. 在项目根目录提供 `agent-shell.config.ts`；密钥放在环境变量。
2. `agent-shell chat` 进入 REPL；`agent-shell run "<task>"` 单次执行。
3. 通过 `/provider`、`/tools`、`/trace` 等命令观察和控制。
4. `agent-shell trace show <run-id>` 回放事件流。
5. 需要团队协作时，用配置里的 `presets` 切换单 agent、supervisor、swarm。

## 5. 功能需求

v0.1 范围内全部为 P0；没有“以后再做”的功能项。实现顺序是内部阶段，不代表发布范围。

| ID | 需求 | 说明 | 验收要点 |
| --- | --- | --- | --- |
| FR-01 | 双 Provider | OpenAI 兼容接口 + Anthropic；统一配置、流式、tool calling、usage、超时与重试 | 两种 provider 都能完成流式对话与工具调用；契约测试离线可跑 |
| FR-02 | 单 agent 循环 | 基于 LangGraph 的模型节点 + 工具节点 + 条件边；支持流式、取消、步数/递归上限 | 多轮工具循环正确终止；Ctrl+C 可取消；超限有明确错误 |
| FR-03 | 工具注册与命名 | 代码注册、目录插件、MCP 三种来源；统一注册表；安全命名与冲突检测 | 三种来源的工具都能被模型调用；重名/非法名在启动时失败 |
| FR-04 | 三档审批 | read 自动；write 一次确认；exec 两次确认；allowlist、`--yolo`、非交互默认拒绝 | 审批矩阵测试通过；拒绝路径返回可恢复的 tool error |
| FR-05 | 工作区边界 | 文件类工具限制在 workspaceRoot；拒绝 `..`、越界绝对路径、symlink 逃逸 | 越界路径被拒绝；`--allow-outside-workspace` 才放行 |
| FR-06 | 子 agent 三形态 | 通用 `spawn` 原语、supervisor、swarm/handoff；上下文隔离、预算、取消传播 | 三种模式各有离线测试；depth/数量/token 上限生效 |
| FR-07 | 会话持久化 | SQLite checkpointer；会话列表、恢复、新建；provider 按 run 切换 | 重启后可恢复会话；跨 provider 新会话可用 |
| FR-08 | Trace 与回放 | JSONL 事件流为真相源；事件关联；脱敏；截断；`trace list/show/tail` | 每个 run 可回放；秘密不出现在 trace；事件 schema 版本化 |
| FR-09 | CLI | `chat` / `run` / `trace` / `tools` / `plugins` / `mcp` / `providers` / `sessions` / `doctor` / `config validate`；REPL 命令 | 命令面完整；`--json` 输出合法 NDJSON；退出码符合规范 |
| FR-10 | 配置 | `agent-shell.config.ts` 作为组合根；zod 校验；环境变量密钥；默认值 | 非法配置启动即失败并给出可操作错误；`doctor` 可诊断 |
| FR-11 | 插件 | manifest + API 版本；显式启用；同进程加载；错误隔离；重名拒绝 | 合法插件可加载；坏插件不影响 shell 启动；API 版本不匹配被拒绝 |
| FR-12 | MCP | `@langchain/mcp-adapters` 2.x；stdio / HTTP；生命周期、超时、命名空间、风险映射 | 本地 echo server 可列出并调用；崩溃返回 tool error；默认风险为 exec |
| FR-13 | 参考场景 | `examples/file-agent`：代码工具 + 插件 + MCP + 三种子 agent 形态 | 场景可独立运行；core 不 import examples |
| FR-14 | 端到端验收 | 一条离线剧本覆盖全部能力；可选 live smoke | `pnpm acceptance` 离线绿；live smoke 双 provider 通过 |
| FR-15 | 运行指标 | 每次 run 记录 token usage、耗时、首 token 延迟、审批次数、子 agent 开销 | trace 可查询；缺失 usage 时标记 estimated |
| FR-16 | 文档与规范 | 需求、架构、路线图、CLI/trace、测试、ADR、`AGENT.md`、README | 链接完整；决策可追溯；阶段文档模板可用 |

## 6. 非功能需求

| ID | 维度 | 要求 |
| --- | --- | --- |
| NFR-01 | 安全 | 默认最小权限；write/exec 不可绕过审批；秘密不落盘；插件/MCP 信任边界写清楚 |
| NFR-02 | 可扩展 | 新增 Provider / 工具 / 插件 / MCP / 子 agent 模式不修改核心循环；公共 API 语义化版本 |
| NFR-03 | 可观测 | 事件 schema 版本化；每个 run 可独立回放；错误能定位到 run/span/tool |
| NFR-04 | 可靠性 | 超时、取消、重试边界明确；单个插件或 MCP server 失败不拖垮 shell |
| NFR-05 | 性能 | 冷启动 < 1s（不含模型首 token）；事件异步批量写，不阻塞流式渲染 |
| NFR-06 | 可移植 | macOS / Linux；Node.js 24.x；pnpm workspace |
| NFR-07 | 可测试 | CI 不调用真实模型；离线 deterministic；live smoke 单独手动执行 |

## 7. 验收标准

- **AC-1**：`pnpm acceptance` 在无 API key、无外网的条件下通过，覆盖 FR-01..FR-15。
- **AC-2**：手动 live smoke 分别用 OpenAI 兼容接口与 Anthropic 完成一次工具调用 + 一次审批 + 一次子 agent，并生成可回放 trace。
- **AC-3**：安全清单通过：审批矩阵、路径越界、秘密脱敏、插件/MCP 信任声明、非交互默认拒绝。
- **AC-4**：文档齐全且交叉链接有效；`AGENT.md` 可用于约束后续实现。
- **AC-5**：核心包无业务代码；`examples/file-agent` 是唯一业务参考场景。

验收剧本与断言见 [04-testing-and-acceptance.md](./04-testing-and-acceptance.md)。

## 8. 关键决策

| ADR | 决策 | 状态 |
| --- | --- | --- |
| [ADR-0001](./decisions/ADR-0001-langgraph-runtime.md) | 运行时采用 LangGraph 1.x / LangChain 1.x，主循环自建 StateGraph，子 agent 复用官方 prebuilt 与 supervisor/swarm 包 | 已接受 |
| [ADR-0002](./decisions/ADR-0002-dual-provider.md) | 双 Provider 通过 LangChain 集成层实现，不做自研 wire protocol | 已接受 |
| [ADR-0003](./decisions/ADR-0003-tool-sources.md) | 代码注册、目录插件、MCP 三源统一进一个 ToolRegistry，统一命名与风险声明 | 已接受 |
| [ADR-0004](./decisions/ADR-0004-tiered-approvals.md) | read 自动、write 一次确认、exec 两次确认；LangGraph interrupt/Command 实现；工作区边界兜底 | 已接受 |
| [ADR-0005](./decisions/ADR-0005-subagent-patterns.md) | 内置 spawn、supervisor、swarm 三种子 agent 形态；预算与取消传播 | 已接受 |
| [ADR-0006](./decisions/ADR-0006-local-trace.md) | 本地 JSONL 事件流为唯一真相源，LangSmith 可选导出 | 已接受 |
| [ADR-0007](./decisions/ADR-0007-trusted-plugins.md) | 插件同进程加载，信任本地代码；v1 不做沙箱，显式启用 | 已接受 |
| [ADR-0008](./decisions/ADR-0008-first-release-scope.md) | 首期一次交付全功能；内部拆 8 个阶段；单一端到端剧本验收 | 已接受 |

## 9. 术语

| 术语 | 含义 |
| --- | --- |
| 壳 / core | `@agent-shell/core`，不含业务逻辑的运行时内核 |
| 首期 / v0.1 | 第一个可发布里程碑，包含本文全部功能需求 |
| 阶段 | 内部实现阶段，有独立验收，但不单独发布 |
| Preset | 配置里的运行预设：single / supervisor / swarm |
| Code tool | 在 `agent-shell.config.ts` 中通过 `defineTool` 注册的工具 |
| Plugin | 目录中带 manifest、同进程加载的本地工具包 |
| MCP | Model Context Protocol server 提供的外部工具 |
| Subagent | 由父 agent 派生的隔离子 agent；含 spawn / supervisor / swarm 三种形态 |
| Run | 一次完整的 agent 执行（可包含多次 interrupt/resume） |
| Session | 跨 run 的会话，对应 LangGraph `thread_id` |
| Span | 事件树中的一个执行节点：run / graph node / llm / tool / subagent |
| Trace | 一个 run 的 JSONL 事件文件 |
| Approval | 对 write/exec 工具执行的用户确认 |

## 10. 阶段 0 需要冻结的契约

以下不是产品问题，而是实现前必须落地的契约；阶段 0 完成后不再保留“待定”。

- `agent-shell.config.ts` 的精确字段与默认值；
- 事件 schema v1 的字段、事件类型、payload 约定；
- Provider capability matrix 与模型选择语法；
- MCP 工具的风险映射规则与命名规范化算法；
- CLI 参数、REPL 命令、退出码；
- 插件 manifest 字段与 `PLUGIN_API_VERSION` 校验规则。
