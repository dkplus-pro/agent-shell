# 02 · 工具内核 + 分档审批 + 工作区边界

> 状态：已完成  
> 开始日期：2026-11-03  
> 完成日期：2026-11-03  
> 关联 ADR：ADR-0003、ADR-0004

## 1. 目标

让工具「可注册、可审批、可观测、不可越界」：ToolRegistry、执行管线、LangGraph interrupt 审批、allowlist/`--yolo`/硬拒绝、工作区路径守卫，并落地 read/write/exec 三个示例文件工具。门禁：审批矩阵/路径越界/拒绝路径测试通过（`docs/02-roadmap.md` §3 阶段 2）。

## 2. 范围

- 做：`packages/core/src/tools/`（registry/naming/path-guard/executor/langchain/types）、`approvals/`（policy/allowlist）、`graph/single.ts` 中 tools 节点的审批前置、`examples/file-agent/tools/`（read-file/write-file/run-shell）。
- 不做：插件与 MCP 两个工具源（阶段 3/4，但注册表已预留 `plugin__`/`mcp__` 命名与冲突检测）、CLI 审批 UI 完整版（阶段 6，交互 prompt 已可用）。
- 对上游：消费阶段 1 的事件总线与单 agent 图；对下游：registry + executor 是 plugin/MCP 工具进入运行时的唯一通道。

## 3. 设计要点

- **注册表纪律**（`tools/registry.ts`）：`registerCode/registerPlugin/registerMcp/registerRuntime` 四条入口；code/plugin 缺 `risk` 直接 `ConfigError`；`plugin__`/`mcp__`/`runtime__` 保留命名空间禁止 code 使用；重名/保留字抛 `NameConflictError`。注册接口 `RegistrableTool` 比 `ToolDefinition` 更宽，解决 `execute` 逆变导致的 `never` 赋值问题。
- **审批 = `interrupt()` + `Command({ resume })`**：`graph/single.ts` 的 `prePassApprovals` 在 tools 节点执行任何 handler 之前跑一遍**纯前置 pass**，按调用顺序收集全部决策（write 一次 `interrupt`、exec 两次，第二次要求 `confirmation === "run"`），再执行工具并把缓冲事件一次性 flush。原因：LangGraph 会在 resume 时从节点第一行重放，任何排在 `interrupt()` 前的副作用都会执行两次——这正是阶段 0 文档遗留问题表预告的坑。前置 pass 无副作用，因此 trace 顺序确定、副作用不重复。
- **策略顺序**（`approvals/policy.ts::evaluateApproval`）：硬拒绝（`HARD_DENY_PATTERNS`/`HARD_DENY_WORDS`，先于一切）→ read 自动 → allowlist → `--yolo` → 非交互默认拒绝 → 交互询问。单词边界匹配使 `sudoer` 不会触发 `sudo`。
- **执行管线**（`tools/executor.ts`）：参数 zod 校验 → 审批 → 超时/abort 竞速 → 结果归一 → `tool.started/approval.requested/approval.decided/finished/error` 事件 → 截断（`DEFAULT_MAX_FIELD_BYTES = 16384`，preview + sha256）。所有失败路径返回错误结果而非 reject，让模型收到 ToolMessage 后有机会自救。
- **路径守卫**（`tools/path-guard.ts`）：normalize → 拒绝 `..` 越界与越界绝对路径 → 对最深存在祖先取 `realpath` 再复检包含关系（拒绝 symlink 逃逸）→ NUL 字节拒绝；唯一放行通道是 `allowOutsideWorkspace`。只用 `path.resolve`/`realpath`，无字符串拼路径。
- **示例工具即 file-agent 第一批工具**：`examples/file-agent/tools/` 中 read/write/exec 三件全部经 `ctx.resolveWorkspacePath`，exec 用 `spawn` + 参数数组 + echo allowlist，符合 AGENT.md §4/§5。

## 4. 任务清单

- [x] `ToolRegistry`：四源注册、命名规范化、冲突检测、风险必填
- [x] `tools/naming.ts`：`plugin__/mcp__/runtime__` 命名空间与保留字检查
- [x] `ToolExecutor`：校验→审批→超时→事件→截断全管线
- [x] `prePassApprovals`：纯前置 pass + exec 双确认 + 决策缓冲
- [x] `evaluateApproval`：硬拒绝/allowlist/yolo/非交互顺序
- [x] `approvals/allowlist.ts`：规则匹配（tool + argsMatch）
- [x] `resolveWorkspacePath`/`guardToolPath`：三类越界拒绝
- [x] `examples/file-agent/tools/{read-file,write-file,run-shell}.ts`
- [x] 审批矩阵测试：read/write/exec × approve/deny/timeout/non-interactive（`packages/core/test/unit/tools-executor.test.ts`，含「write: approval timeout is a deny」）
- [x] 路径守卫矩阵：`../`、`/etc/passwd`、symlink 逃逸（`tools-path-guard.test.ts`，21 例）

## 5. 验收证据

```text
$ npx vitest run packages/core/test/unit   # 阶段 2 相关
tools-registry.test.ts     26 通过（命名空间、重名、缺 risk 拒绝）
tools-path-guard.test.ts   21 通过（../、绝对越界、symlink、NUL）
tools-executor.test.ts     通过（审批矩阵、超时、取消、截断、拒绝→ToolMessage）
```

- 关键输出摘要：exec 两次确认都通过才执行、任一步拒绝返回拒绝消息；同一轮多个 tool call 顺序执行、审批串行、trace 顺序确定（前置 pass 决策与 executor 逐一对应）；拒绝后模型收到 ToolMessage。
- trace run ID：测试临时 trace 目录，不落库。
- 已知限制：审批超时 `timeoutMs: 0` 语义为「无 UI 等待即拒」，交互式计时 UI 在阶段 6。

## 6. 偏差与决策

- 阶段 0 遗留问题「interrupt 重放导致副作用重复」按计划以纯前置 pass 解决（`graph/single.ts` 注释记录了 why），无需新 ADR；exec 第二确认非 `run` 时决策回写机制（覆盖倒数第二条 approve）是实现期新增细节。
- roadmap 交付物写「代码工具注册（config 组合根）」：注册入口在 `defineTool` + 配置 schema `tools.code`，示例落在 `examples/file-agent/`，core 不含业务工具，符合架构不变量。

## 7. 遗留问题

| 问题 | 影响 | 处理阶段 | 负责人 |
| --- | --- | --- | --- |
| 插件/MCP 工具不受路径守卫自动约束 | 信任完全依赖 risk 声明 | 已接受（ADR-0003/0007），文档在 `docs/01` §7 | — |
| 审批 prompt 的完整 CLI 渲染（工具名/来源/风险/原始 target） | 阶段 2 仅最小交互 | 阶段 6 | cli |

## 8. 关联

- 需求：FR-03、FR-04、FR-05；门禁：`docs/02-roadmap.md` §3 阶段 2
- 架构：`docs/01-architecture.md` §5.4/§5.5/§7、`docs/03-cli-and-trace.md` §5
- Commit / Tag：见仓库 `main`
