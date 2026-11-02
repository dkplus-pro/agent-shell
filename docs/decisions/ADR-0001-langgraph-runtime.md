# ADR-0001 · 采用 LangGraph 作为运行时

> 状态：已接受  
> 日期：2026-11-03  
> 关联：[01-architecture.md](../01-architecture.md)

## 背景

需求同时要求“无业务、可扩展”和“能看到 agent 如何一步步搭起来”。评估后，用户明确选择 LangGraph/LangChain，并接受“架构优先、循环可见性降级为项目记录 + 运行时事件流”。

同时需要 interrupt 审批、checkpoint 会话、子图、supervisor/swarm 和 MCP 集成；从零实现这些会显著拖慢首期。

## 决策

- 运行时采用 `@langchain/langgraph` 1.6 + `@langchain/core` 1.3。
- **主单 agent 循环**用自建 `StateGraph`（model 节点 + tools 节点 + 条件边），以便精确控制预算、审批、事件和取消。
- **子 agent 叶子**使用 `@langchain/langgraph/prebuilt` 的 `createReactAgent`，因为 `@langchain/langgraph-supervisor` / `-swarm` 依赖该形态。
- supervisor/swarm 通过 core 的 adapter 包装官方包；CLI 不直接 import。
- 上游调用集中在 adapter 层，版本精确锁定。

## 后果

**正面**：

- 直接获得 interrupt/resume、checkpoint、子图、流式、supervisor/swarm、MCP 适配。
- 首期范围（全功能）在可控工作量内可实现。
- 事件层只需补“可观测”，不用自己造状态机。

**负面/风险**：

- 核心循环归框架，无法逐行展示“agent 内部怎么转”；可见性由阶段文档和事件流承担。
- 上游 1.x API 仍在演进；supervisor/swarm 相对年轻。
- 需要 adapter 层控制变更扩散；升级必须跑全量验收。

## 备选方案

- **从零写循环**：最贴合可见性，但子 agent、审批、持久化、流式全部自写，首期不可行。
- **Vercel AI SDK**：流式/工具调用开箱即用，但核心循环黑盒，且 supervision/swarm 需另造。
- **LangGraph 只做子 agent**：两套运行时并存，边界复杂，已否决。

## 复审条件

- 上游出现无法在 adapter 内兼容的破坏性变更；
- 事件层无法满足“回放每一步”的验收；
- 用户重新把“循环可见性”升为硬目标。
