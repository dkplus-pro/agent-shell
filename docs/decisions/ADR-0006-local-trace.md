# ADR-0006 · 本地事件流为唯一真相源

> 状态：已接受  
> 日期：2026-11-03  
> 关联：[03-cli-and-trace.md](../03-cli-and-trace.md)

## 背景

“看见 agent 每一步”的运行时载体需要选型：LangSmith 图级 trace、终端日志、自研 JSONL、或自建 Web UI。用户选择“本地事件流为准，LangSmith 可选”。

## 决策

- 每个 run 写一个 JSONL 文件：`.agent-shell/traces/<sessionId>/<runId>.jsonl`。
- 事件 schema v1：信封 + 类型化 payload；`v`、`id`、`ts`、`sessionId`、`runId`、`spanId`、`parentSpanId`、`type`、`source`。
- 采集：LangGraph custom stream writer（`config.writer`）+ LangChain callback handler。
- 写入：内存队列 + 批量追加；不阻塞流式渲染；run 结束时 flush。
- 脱敏与截断：默认不落 token delta、不落完整消息历史、不落 headers；工具结果/参数预览上限 16KB。
- 查看器：`trace list/show/tail`；CLI 树形渲染；`--json`/`--raw` 输出原始数据。
- LangSmith：可选投影，默认关闭；通过 `LANGSMITH_*` 环境变量开启；不参与验收、不作为依赖。

## 后果

**正面**：

- 数据留在本地；无外部服务依赖；离线可回放。
- 事件 schema 稳定后可接 Web UI、分析工具、成本报表。
- 与 LangSmith 解耦，避免供应商绑定。

**负面/风险**：

- 需要自己维护 schema、查看器、脱敏与截断。
- 早期查看器能力弱于 LangSmith UI。
- trace 体积随工具输出增长；需要截断策略。

## 备选方案

- **直接依赖 LangSmith**：最快获得图级 UI，但数据上云、需联网/key，壳被外部服务绑定。
- **只保留终端日志**：无法回放/比对，与目标冲突。
- **首期自建 Web UI**：范围过大，v1 不做。

## 复审条件

- 本地 trace 体积/查询成为瓶颈；
- 需要团队共享/远程查看；
- 用户明确要求 Web 观测台。
