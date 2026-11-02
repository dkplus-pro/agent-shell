# ADR-0005 · 内置三种子 agent 形态

> 状态：已接受  
> 日期：2026-11-03  
> 关联：[01-architecture.md](../01-architecture.md)

## 背景

用户明确要求首期内置三种子 agent 形态：通用 spawn、supervisor + worker、swarm/handoff。三者语义不同，不能用一个“万能编排器”模糊掉。

## 决策

- **spawn**：自建原语 `runtime__spawn_subagent`：
  - 子 agent 独立 messages、独立 run/span；
  - 工具集必须是父工具集的子集；
  - 只传 task + 显式 context，只回传最终答案；
  - 默认 depth ≤ 2、每次 run ≤ 8 个子 agent、子 agent maxSteps 默认 20；
  - 父取消级联到子；子失败以 ToolMessage 返回父。
- **supervisor**：包装 `@langchain/langgraph-supervisor` 的 `createSupervisor`；支持 `full_history` / `last_message`。
- **swarm**：包装 `@langchain/langgraph-swarm` 的 `createSwarm` + `createHandoffTool`；共享 messages、`activeAgent`；必须带 checkpointer。
- 叶子 agent 使用 `createReactAgent`（swarm 当前仅支持该形态）。
- 三种形态都发 `subagent.started/finished`；supervisor/swarm 额外发 `subagent.handoff`。
- 不做通用编排 DSL，不内置第四种模式。

## 后果

**正面**：

- 三种真实可用的协作模式，覆盖层级分派、去中心化移交、一次性隔离任务。
- 预算、取消、trace 嵌套统一，验收可枚举。
- 官方包负责图组合，core 只做适配与约束。

**负面/风险**：

- supervisor/swarm 上游相对年轻，API 可能变化；需锁版本 + 契约测试。
- 三套测试与示例增加工作量。
- spawn 的上下文隔离意味着子 agent 不能“看到”父历史；复杂任务需要显式传 context。
- 预算统计跨子图，需要仔细实现。

## 备选方案

- **只做 spawn**：最灵活，但用户明确要求三种都内置。
- **只做 supervisor**：固定拓扑，不适合移交场景。
- **自研通用多 agent 框架**：范围爆炸，且会变成“框架的框架”。

## 复审条件

- 上游 supervisor/swarm 出现无法适配的破坏性变更；
- 三种模式之一在实际使用中无人使用；
- 需要第四种模式（如 debate、debate-judge）时，按新 ADR 处理。
