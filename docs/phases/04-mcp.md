# 04 · MCP 客户端

> 状态：已完成  
> 开始日期：2026-11-03  
> 完成日期：2026-11-03  
> 关联 ADR：ADR-0003、ADR-0004

## 1. 目标

接入外部 MCP 生态且默认不信任：`@langchain/mcp-adapters` v2 的唯一封装点、stdio/HTTP 传输、生命周期与 `close()`、命名空间与风险映射、`mcp list/status`、本地 echo server 示例。门禁：本地 MCP server 可列可调；崩溃/超时可控（`docs/02-roadmap.md` §3 阶段 4）。

## 2. 范围

- 做：`packages/core/src/mcp/`（adapter/index）、config schema 的 `mcpServerConfigSchema`（stdio/http discriminated union）、`registerMcp` 接入 ToolRegistry、`agent-shell mcp list/status`（`packages/cli/src/commands/inspect.ts`）、示例 server `examples/file-agent/mcp-echo-server/server.mjs`（stdio，提供 `echo` readOnlyHint 与 `write_note`）。
- 不做：MCP server 端管理/鉴权、streamable HTTP 以外的上游新特性跟进、把 MCP 输出当指令解释（明确禁止）。
- 对上游：消费阶段 2 的 registry/审批管线；对下游：阶段 5 子 agent 的工具子集可包含 `mcp__` 工具，阶段 7 acceptance 用 stdio echo server 作为 Act 3。

## 3. 设计要点

- **单文件隔离上游**：`mcp/adapter.ts` 是全仓库唯一 import `@langchain/mcp-adapters` 的模块（头注释 + acceptance 静态检查 `assertCliDoesNotConstructUpstream` 兜底），上游类型全部在文件内转成 agent-shell 契约（`McpToolDescriptor`/`McpServerStatus`/`McpErrorPayload`）。
- **信任模型**：server 外部不可信 → 风险映射在 `riskFor()`：配置 `riskOverrides` 优先，其次 `annotations.readOnlyHint === true → read`，其余一律 `exec`（走阶段 2 双确认审批）；调用结果只作为数据回传模型，永不自动批准。
- **生命周期**：`MCPAdapter.connectAll()` 逐 server 连接，不可达者发 `mcp.error` 并保留空目录，不影响其他 server；`mcp.connected/mcp.disconnected/mcp.error` 事件 payload 由 event schema v1 逐键校验。`close()` 带 `CLOSE_GRACE_MS = 5000` 拆除护栏，卡死的握手不会挂住退出。
- **超时纪律**：`withTimeout()` 竞速并清表；SDK 自身的 backstop 定时器（`UPSTREAM_TIMEOUT_BACKSTOP_MS = 5000`）刻意排在配置超时之后，避免上游超时抢跑被误报为 server 故障。`TRANSPORT_DEATH` 正则只在真正的传输层死亡时标记 disconnected，普通 JSON-RPC 错误保持连接状态。
- **命名与冲突**：目录化工具名 `mcp__<server>__<tool>`（`tools/naming.ts::mcpToolName`）；两个 server 申报同一命名空间名时整个 connect 中止（静默丢弃会把调用路由到错误 server）。
- **子进程环境**：stdio server 只按 `envVars` 名单转发变量名、值留在环境里（`childEnvironment()`），遵守秘密纪律。

## 4. 任务清单

- [x] `mcpServerConfigSchema`：stdio（command/args/envVars/timeoutMs/enabled/riskOverrides）+ http（url/...）
- [x] `MCPAdapter`：connectAll / tools / get / status / call / close，逐 server 状态机
- [x] 风险映射与 `riskOverrides`；`readOnlyHint → read`，默认 `exec`
- [x] `registerMcp` 进入 ToolRegistry（命名空间、与 code/plugin 冲突检测）
- [x] `agent-shell mcp list` / `mcp status`（human + `--json`）
- [x] `examples/file-agent/mcp-echo-server/server.mjs`（`@modelcontextprotocol/sdk` stdio server，两工具）
- [x] `packages/core/test/unit/mcp-adapter.test.ts`（20 例，含 fake upstream 注入）
- [x] `examples/file-agent/test/scenario.test.ts` 用真实 `StdioClientTransport` 验证 echo server 可列两工具

## 5. 验收证据

```text
$ npx vitest run packages/core/test/unit/mcp-adapter.test.ts
20 通过：连接与目录、状态、调用超时（MCP_TIMEOUT）、崩溃隔离（保持其余 server）、
        命名冲突中止、risk 映射、http 配置校验 + 不可达端点隔离
$ npx vitest run examples   # scenario.test.ts 真实 stdio 握手
echo server 列出 echo / write_note 并可调用
```

- 关键输出摘要：本地 stdio server 可列可调（acceptance Act 3 的 `mcp__echo__echo` 有 `tool.started source="mcp"` 断言）；server 崩溃/超时返回 tool error，不拖垮 shell；禁用/不可达 server 不阻塞其他功能；名称冲突在启动时失败。
- trace run ID：acceptance 临时 workspace 产生。
- 已知限制：http transport 仅有配置校验与不可达隔离测试，没有针对本地 HTTP MCP server 的成功调用测试（见 §7）。

## 6. 偏差与决策

- 计划 vs 实际：roadmap 交付物写「懒连接」，实现为**启动时 `connectAll` 急切连接 + 逐 server 失败隔离**。理由：`mcp list/status` 与 doctor 需要即时目录与状态，懒连接会让首个工具调用承担连接延迟与不可预测的失败点；不可达 server 已被隔离，不违背「不阻塞其他功能」的门禁。属于实现策略偏差，未改契约，不新增 ADR。
- 上游 `MCPAdapter` v2 的 connect/工具形态与 roadmap 编写时的调研有出入（工具是 `DynamicStructuredTool`），全部在 adapter 内消化，core 其余部分不见上游类型。

## 7. 遗留问题

| 问题 | 影响 | 处理阶段 | 负责人 |
| --- | --- | --- | --- |
| http transport 无本地 server 成功路径测试 | 仅静态验证过 http 配置与隔离 | 后续增强（live smoke 之外补本地 http server） | core |
| MCP server 输出可能被模型当指令 | 提示注入面 | 已缓解（输出仅回传文本 + 默认 exec 审批），长期靠纪律（AGENT.md §5） | — |

## 8. 关联

- 需求：FR-12；门禁：`docs/02-roadmap.md` §3 阶段 4
- 架构：`docs/01-architecture.md` §5.4/§7、`docs/03-cli-and-trace.md` §2（mcp 命令）
- Commit / Tag：见仓库 `main`
