# 05 · 子 agent 三形态

> 状态：已完成  
> 开始日期：2026-11-03  
> 完成日期：2026-11-03  
> 关联 ADR：ADR-0001、ADR-0005

## 1. 目标

把 spawn、supervisor、swarm 三种形态做成可配置、可观测、有预算的原语：`runtime__spawn_subagent` 工具、两个上游预置图的 adapter、深度/数量/token/时间预算、取消传播、`parentSpanId` trace 嵌套。门禁：三形态各自测试通过；深度/数量/预算生效（`docs/02-roadmap.md` §3 阶段 5）。

## 2. 范围

- 做：`packages/core/src/agents/`（spawn/supervisor/swarm/handoff/react/index）、`limits.ts`（`DEFAULT_LIMITS`：maxSteps 40、tokenBudget 200k、maxSubagents 8、maxSubagentDepth 2）、`runtime/run-manager.ts` 的 preset 分发与预算视图、`tooling` 无关的三个 preset 剧本（示例配置在 `examples/file-agent/agent-shell.config.ts`）。
- 不做：第四种子 agent DSL（AGENT.md §4 明令禁止）、跨 session 的子 agent 复用、子 agent 独立审批通道（复用父 run 的管线）。
- 对上游：消费阶段 2 的 registry/审批与阶段 1 的总线/checkpointer；对下游：阶段 6 的 `sessions resume` 要能恢复 supervisor/swarm 线程，阶段 7 的 Act 6/8/9 驱动三形态。

## 3. 设计要点

- **spawn**（`agents/spawn.ts`）：`runtime__spawn_subagent` 由 RunManager **每 run 注册**（`run-manager.ts` 注「registered per run so its budget view is live」），闭包持有实时 depth/count/tokens；args schema 为 task/agent/context。子 run 走**独立消息历史 + `registry.subset()` 解析出的工具子集**（请求未授权工具直接拒绝），只有最终答案回传父消息。预算违规先 emit `budget.exceeded` 再以 `SubagentError(BudgetExceededError)` 拒绝 → 递归 spawn 被 depth 预算挡住（`agents-spawn.test.ts`）。**失败的孩子不杀父 run**：非取消错误返回文本 `subagent failed: …`；取消前置于 `subagent.started` 之前检查，trace 里不会留下有 started 无 finished 的子 span。
- **supervisor**（`agents/supervisor.ts`）：包装 `@langchain/langgraph-supervisor` 1.1.3 `createSupervisor`，`outputMode` 只接受 `full_history`/`last_message`（对照上游真实类型，无 `last_history`）；**无 checkpointer 直接 `ConfigError`**，与 `docs/01-architecture.md` §5.6 一致。
- **swarm**（`agents/swarm.ts`）：包装 `@langchain/langgraph-swarm` 1.0.4；上游不会自动接 handoff，adapter 为每个 agent 追加 `createHandoffTool` 指向其余 agent；`activeAgent` 通道（`SWARM_ACTIVE_AGENT_KEY`）同样强制 checkpointer。
- **叶子统一走 prebuilt**：`agents/react.ts` 用 `createReactAgent` + `applyStepBudget`（recursionLimit ≈ steps×2），与阶段 1 的手工单 agent 图分工明确——多 agent 内部循环交给上游预置，事件与审批仍在我们的 ToolExecutor/总线上。
- **handoff 观测**（`agents/handoff.ts`）：`classifyHandoffToolName` 按钉住的 SDK 实际命名（`transfer_to_*`/`transfer_back_to_*`，含 `trim→lower→_` 规范化）把工具调用映射为 `subagent.handoff` payload，纯函数、可测。
- **trace 嵌套**：子 run 的每个 span 携带 `parentSpanId` 指向父 span，`subagent.started/finished` payload 带 `pattern/name/depth/usage`；`llm.*` 的 `agent` 字段区分说话者。
- **确定性离线**：supervisor/swarm 预置的每个 leaf 靠 `scripts["agent:<name>"]` 解析专属剧本（阶段 1 的 per-agent 机制），三形态全离线可测。

## 4. 任务清单

- [x] `agents/spawn.ts`：`createSpawnToolDefinition`、三重预算（depth/count/tokens）、工具子集、隔离历史、错误回传文本
- [x] `agents/react.ts`：`LeafAgentSpec` + prebuilt `createReactAgent` + `applyStepBudget`
- [x] `agents/supervisor.ts`：`buildSupervisorGraph`、outputMode 校验、checkpointer 强制
- [x] `agents/swarm.ts`：`buildSwarmGraph`、handoff 工具织入、`activeAgent` 键、checkpointer 强制、≥2 agent 校验
- [x] `agents/handoff.ts`：handoff 工具名分类（纯函数）
- [x] `run-manager.ts`：preset 分发（single/supervisor/swarm）、spawn 每 run 注册、`subagent.*`/`budget.exceeded` 事件、父取消级联
- [x] 三个 preset（single/team/swarm）示例配置 + 每 agent 剧本
- [x] `packages/core/test/graph/{agents-spawn,agents-supervisor,agents-swarm,agents-handoff,run-manager-preset}.test.ts`（run-manager 多 agent 预置 3 例；取消级联、无 checkpointer 拒绝编译、swarm 跨轮恢复均有断言）

## 5. 验收证据

```text
$ npx vitest run packages/core/test/graph
agents-spawn / agents-supervisor / agents-swarm / agents-handoff 全绿；
run-manager.test.ts 15（单 agent）+ run-manager-preset.test.ts 3（多 agent 预置）
断言覆盖：子 agent 看不到父历史、工具子集受限、子失败回 ToolMessage、
递归 spawn 被拒、路由与 outputMode、handoff 后 activeAgent 跨轮恢复、
无 checkpointer 启动失败、depth/count/token 超限发 budget.exceeded、父取消级联
```

- 关键输出摘要：三形态各自产出 `subagent.started`（pattern = spawn/supervisor/swarm）且 depth ≤ 限额；acceptance 的 `assertSubagents` 进一步要求 ≥2 条 `subagent.handoff`。
- trace run ID：测试临时目录产生。
- 已知限制：swarm 的 `activeAgent` 只能通过 checkpointer 持久（上游设计）；预算统计按 run 聚合，跨 run 不累计。

## 6. 偏差与决策

- roadmap 风险预案「swarm 仅支持 prebuilt `createReactAgent`」属实：leaf 一律经 `react.ts` 构建，未内联复刻上游图（预案的「必要时」未触发）。
- 上游 supervisor 版本实际无 `last_history` 模式，`supervisor.ts` 头注释以钉住版本实测为准修正了调研文档；未构成契约变更。
- acceptance 配置把 `maxSubagentDepth` 收紧为 1、`maxSubagents` 收紧为 4（比默认更严），用于确定性演练 `depthGuard` 负例。

## 7. 遗留问题

| 问题 | 影响 | 处理阶段 | 负责人 |
| --- | --- | --- | --- |
| swarm `activeAgent` 仅经 checkpointer 持久 | 无 checkpointer 时跨轮状态丢失（已被 ConfigError 挡住） | 已接受（ADR-0005） | — |
| supervisor/swarm 上游仍年轻 | 升级需重跑契约测试 | 长期（AGENT.md §2 版本锁定） | core |
| 子 agent token 预算按父 run 累计估算 | 估算 usage 时边界偏保守 | 暂不解决（README 限制） | — |

## 8. 关联

- 需求：FR-06、FR-15；门禁：`docs/02-roadmap.md` §3 阶段 5
- 架构：`docs/01-architecture.md` §5.6、`docs/04-testing-and-acceptance.md` §2.3
- Commit / Tag：见仓库 `main`
