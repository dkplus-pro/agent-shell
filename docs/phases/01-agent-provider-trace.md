# 01 · 单 agent + 双 Provider + 流式 + trace

> 状态：已完成  
> 开始日期：2026-11-03  
> 完成日期：2026-11-03  
> 关联 ADR：ADR-0001、ADR-0002、ADR-0006

## 1. 目标

跑通「输入 → 模型 → 工具 → 模型 → 输出」的最小闭环：自建 LangGraph 单 agent 图、双 Provider 注册表、流式渲染、JSONL 事件总线与 SQLite checkpointer，并留下完整事件流。门禁：离线多轮工具循环通过；双 Provider 契约测试通过（`docs/02-roadmap.md` §3 阶段 1）。

## 2. 范围

- 做：`packages/core/src/graph/single.ts`（StateGraph 主循环）、`providers/`（registry/openai/anthropic/usage/types）、`events/`（schema/bus/sinks/reader/truncate/redaction）、`testing/`（ScriptedChatModel）、`storage/checkpointer.ts`（SQLite）、`runtime/run-manager.ts` 单 agent 路径、`ids.ts`、`limits.ts`。
- 不做：审批 interrupt（阶段 2，本阶段 `prePassApprovals` 只走 read 自动放行）、插件/MCP/子 agent（阶段 3–5）、trace 树形 viewer（阶段 6）。
- 对下游：RunManager 与事件总线是所有后续阶段的运行时底座；`llm.*`/`tool.*`/`run.*` 事件形状由 event schema v1 冻结。

## 3. 设计要点

- **自建图而非 prebuilt agent**：`graph/single.ts` 用 `StateGraph` 手工搭 `model` 节点 + `tools` 节点 + 条件边 `route`（有 tool_calls → tools，否则 END），`tools → model` 回边；这是 ADR-0001「事件与审批必须落在我们控制的节点上」的直接体现。叶子 agent（阶段 5）才使用 prebuilt `createReactAgent`（`agents/react.ts`）。
- **ProviderRegistry**（`providers/registry.ts`）：handle 按 `provider:model[#agent]` 缓存，保证同一 ScriptedChatModel 实例被复用、步游标连续；`withCapabilityGuard` 在模型不支持 tool calling 却收到工具时抛 `ProviderError`，不让其静默忽略；只有 `providers/openai.ts` 与 `providers/anthropic.ts` 触碰 SDK 模型（acceptance 静态检查 + AGENT.md §2）。
- **逐 agent 剧本**：`scriptKeys` 优先解析 `scripts["agent:<name>"]`，再退到 `provider:model`/`model`/`provider`；这是 supervisor/swarm 预置离线确定性的机制（阶段 5 复用）。
- **usage 归一**：`providers/usage.ts` 将 OpenAI/Anthropic 的 usage 字段与 `usage_metadata` 统一为 `TokenUsage`，缺省时按字符估算并置 `estimated: true`；RunManager 汇总进 `llm.completed` 与 `run.finished`。
- **事件流**：`events/bus.ts` 在派发前做脱敏（见阶段 0 文档）+ 截断（`events/truncate.ts`，preview + sha256），`sinks.ts` 提供 JSONL 文件 sink（run 目录 0700/文件 0600）与 console sink；`reader.ts` 容错读取——坏行跳过并回报 warnings，绝不抛出。
- **信封即契约**：`events/schema.ts` 要求 `id^evt_ / sessionId^ses_ / runId^run_ / spanId^spn_` 前缀（`ids.ts` 生成），`EVENT_PAYLOAD_SCHEMAS` 对每类事件 payload 逐类型 `.strict()`；schema 漂移在 trace 回读时立即暴露。
- **取消**：模型调用与图执行透传 `AbortSignal`；Ctrl+C 走 CLI，退出码 130，checkpoint 与已落盘事件保留（`packages/cli/test/e2e/exit-codes.test.ts`）。

## 4. 任务清单

- [x] `graph/single.ts`：StateGraph + 条件边 + checkpointer 注入
- [x] `providers/registry.ts`：缓存、能力守卫、scripted/openai/anthropic 三种 handle
- [x] `providers/openai.ts` / `providers/anthropic.ts`：SDK 适配 + 流式 + 重试/超时
- [x] `providers/usage.ts`：双 Provider usage 归一
- [x] `events/bus.ts` / `sinks.ts` / `truncate.ts` / `reader.ts` / `redaction.ts`
- [x] `testing/scripted-model.ts`：JSON 剧本（content/toolCalls/usage/error/stream），`@agent-shell/core/testing` 子路径导出
- [x] `storage/checkpointer.ts`：SQLite（better-sqlite3）+ sessionId/threadId
- [x] `runtime/run-manager.ts`：run 生命周期、`run.started/finished/error`、预算接入
- [x] 契约测试：本地 127.0.0.1 HTTP mock 流式分片、tool call 解析、usage、超时、重试
- [x] 离线多轮工具循环图测试（`packages/core/test/graph/run-manager.test.ts`，15 例单 agent）

## 5. 验收证据

```text
$ npx vitest run packages/core   # 阶段 1 相关（全量口径见阶段 7）
Test Files  packages/core/test/unit/{events-truncate,events-redaction,events-bus,events-reader,providers-usage,providers-registry,testing-scripted-model}.test.ts
            packages/core/test/contract/{providers-openai,providers-anthropic}.test.ts
            packages/core/test/graph/run-manager.test.ts
Tests       events 单元合计 69（truncate/redaction/bus/reader）、usage 14、registry 19、testing 11、
            run-manager 单 agent 15；双 Provider 契约测试对本地 HTTP mock 全部通过
```

- 关键输出摘要：离线剧本 3 轮对话、≥2 次工具调用、最终输出正确（run-manager 图测试）；trace JSONL 每行通过 `validateEvent`，含 `run.started/finished`、`llm.started/completed`、`tool.started/finished`；CI 全程无真实 API key。
- trace run ID：`.agent-shell/traces/<ses>/<run>.jsonl` 由测试临时目录生成，不落库。
- 已知限制：树形 `trace show` 在阶段 6 交付；本阶段 CLI 流式渲染命令面尚未完整。

## 6. 偏差与决策

- TypeScript 固定 6.0.3、构建用 `tsc`：沿用阶段 0 已记录的回退（`docs/02-roadmap.md` 阶段 0 预案、`docs/01-architecture.md` §10），无新增 ADR。
- **malformed spanId 教训**：一次 run 结束事件曾携带不合 `^spn_` 前缀的 spanId，写入时未被拦截、回读时被 `reader.ts` 按坏行丢弃并产生 warning，暴露「总线不校验信封」的盲区；修复为在 schema 信封层强制前缀正则并有回归测试（`events-reader.test.ts`）。此为计划外偏差，值得引以为戒：契约在写入侧也要执法。
- 仅用于测试的 echo 工具内联在测试 helper（`test/graph/helpers/fake-model.ts` 等）而非业务示例，符合「不进入业务示例」约束。

## 7. 遗留问题

| 问题 | 影响 | 处理阶段 | 负责人 |
| --- | --- | --- | --- |
| interrupt 审批路径未接入 tools 节点 | write/exec 尚不能审批 | 阶段 2 | core |
| token 级流式增量事件默认关闭（仅文本 token 回调） | trace 无法逐 token 回放 | 暂不解决（README 非目标） | — |
| `trace show` 树形渲染缺失 | 阶段 1 只能 jq 读 JSONL | 阶段 6 | cli |

## 8. 关联

- 需求：FR-01、FR-02、FR-08、FR-15；门禁：`docs/02-roadmap.md` §3 阶段 1
- 架构：`docs/01-architecture.md` §5.2/§5.3/§5.7/§5.8、`docs/03-cli-and-trace.md` §6/§7
- Commit / Tag：见仓库 `main`（阶段 7 结束打 `v0.1.0`）
