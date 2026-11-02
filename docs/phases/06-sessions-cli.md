# 06 · 会话 + CLI 完整体验

> 状态：已完成  
> 开始日期：2026-11-03  
> 完成日期：2026-11-03  
> 关联 ADR：ADR-0006、ADR-0008

## 1. 目标

从「能跑」到「像一个可用的 shell」：SQLite sessions 元数据、`sessions list/resume`、REPL 命令面、树形 trace viewer、human/`--json`/`--quiet` 输出模式、`--script` 脚本模式、完整 `doctor` 与统一退出码。门禁：重启恢复；NDJSON 合法；剧本模式确定（`docs/02-roadmap.md` §3 阶段 6）。

## 2. 范围

- 做：`packages/core/src/storage/`（sessions/checkpointer/index，sessions 表只管元数据）、`packages/cli/src/` 全部（index/flags/context/run·chat·trace·inspect·doctor 命令、repl、render/renderer、approvals/prompt·script、trace-view）、`events/reader.ts` 的 `listRuns/buildSpanTree/renderSpanTree/tailTrace` 支撑。
- 不做：Web UI、补全/TUI 美化、跨机器 session 同步；CLI 不构造模型/MCP adapter（AGENT.md §2，acceptance 静态检查兜底）。
- 对上游：CLI 只组合 core 的能力；审批 interrupt 的 resume 决策由 CLI 的 prompt/script handler 提供（阶段 2 管线）。

## 3. 设计要点

- **流分离纪律**（`render/renderer.ts`）：结果走 stdout、进度/诊断/错误走 stderr；`--json` 模式下 stdout 仅 NDJSON（每行一个合法 AgentEvent），CLI E2E 逐行 `JSON.parse` 断言。core 无 `console.log`。
- **sessions 表与 checkpointer 分表同库**（`storage/sessions.ts` 头注释）：`state.sqlite` 内 sessions 只存 id/title/时间戳/last_provider·model/run_count，对话状态全部归 checkpointer 表，元数据与可恢复状态不允许漂移成两个文件；全部参数化 prepared statement。
- **resume = 新进程重建线程**：`sessions resume <id>` 与 `run/chat --session <id>` 走 RunManager `options.resume`，发 `session.resumed` 事件，checkpoint 历史继续可跑（`run-manager-preset.test.ts` 有 session.resumed 断言）；审批 resume 用 LangGraph `Command({ resume })`（阶段 2 机制）。
- **REPL 命令面**（`repl/commands.ts`）：`/help /provider /preset /tools /plugins /mcp /trace /history /new /sessions /session /config /quit(/exit)`；`/provider` 收完整 `provider:model` 引用（`/model` 并入其中）。
- **trace viewer**（`commands/trace.ts` + `trace-view.ts` + core `events/reader.ts`）：读取/建树/渲染全在 core，CLI 只做形状化；`trace show` 支持全 ID 或唯一前缀、`--raw` 输出原始 JSONL、`--json` 输出 NDJSON；树含 run/llm/tool/approval/subagent 层级、token、耗时。
- **脚本模式**（`approvals/script.ts`）：`--script <file>` 用 zod `.strict()` schema（version 1，provider/preset/turns/approvals）；审批按声明序消费，未授权的 write/exec **拒绝并判失败**（退出码 5），turn 断言 `expect.contains`/`expect.exitCode`；全程无 TTY、完全确定。
- **doctor 与退出码**：`core/src/config/doctor.ts` 检查配置、provider key 环境变量（只报变量名）、插件目录、MCP server；`--probe` 构造 handle 不发请求；CLI `config validate` 无副作用校验。退出码 0/1/2/3/4/5/6/130 由 `errors/index.ts` 集中映射，`main()` 兜底 `exitCodeFor`。
- **Ctrl+C**：SIGINT → AbortSignal → 事件落盘、checkpoint 保留、退出 130（`exit-codes.test.ts`）。

## 4. 任务清单

- [x] `storage/sessions.ts` + `sessions list/resume` 命令；`--session` 全局旗标
- [x] REPL 全套命令（含 `/config`、`/history`）与 `/quit` 无 TTY 行为（`run.test.ts`）
- [x] `trace list/show/tail`（human 树 + `--json` + `--raw`）
- [x] 输出模式 human/`--json`/`--quiet`/`--no-color`（`flags.ts` + renderer）
- [x] `--script` 审批决策 + turns 断言（`approvals/script.ts`）
- [x] 交互式审批 prompt（`approvals/prompt.ts`：工具名/来源/风险/原始 target，非模型摘要）
- [x] `doctor` + `doctor --probe` + `config validate`
- [x] 退出码统一映射与 CLI E2E：`packages/cli/test/e2e/{run,exit-codes,script-mode,trace}.test.ts`（40 例）+ `test/unit/{approval-script,repl-commands}.test.ts`（21 例）
- [x] `storage-sessions.test.ts`（17 例单元）

## 5. 验收证据

```text
$ npx vitest run packages/core/test/unit/storage-sessions.test.ts   # 17 通过
$ npx vitest run packages/cli   # e2e run/exit-codes/script-mode/trace + unit（计数待全量重跑并入阶段 7 口径）
$ npx vitest run   # 全量（阶段 6 时点，未含 CLI）：22 files / 352 tests 全绿
```

- 关键输出证据摘要：重启后 `sessions resume` 恢复历史并可继续；`trace show --json` 每行合法 JSON；脚本模式在无 TTY 下确定通过；`--json` 保持 stdout NDJSON-only 同时退出码不丢（exit-codes E2E）；`/provider` 切换作用于下一个 run。
- trace run ID：E2E 在临时目录生成（不落库）。
- 已知限制：CLI E2E 套件在 352 基线之后添加，合并计数待阶段 7 全量重跑确认（见 07 §5）。

## 6. 偏差与决策

- `/model` 独立命令未做：模型引用本身是 `provider:model` 一体（`parseModelRef`），`/provider <p:m>` 已覆盖，另设 `/model` 会造成两个状态源；新增 `/preset`、`/history`、`/session`、`/config` 补足 REPL 体验。
- `sessions new` 未做成子命令：新会话由 `run/chat --session <新 id>` 或 `/new` 隐式创建，显式 `new` 与默认行为二选一易混淆。
- 「同 thread provider 不兼容时 `/new` 提示」：消息历史与 provider 无关、切换发生在 run 边界，实测未见不兼容路径，显式警告未实现——记入遗留问题而非假装已有。

## 7. 遗留问题

| 问题 | 影响 | 处理阶段 | 负责人 |
| --- | --- | --- | --- |
| provider 切换缺显式「不兼容 → /new」提示 | 极端跨 provider 恢复场景可能困惑 | 后续增强 | cli |
| Windows 不支持（路径/信号/tty 假设 POSIX） | 平台限制 | 非目标（README） | — |
| CLI E2E 计数未并入全量口径 | 报告数字待刷新 | 阶段 7 收口 | docs |

## 8. 关联

- 需求：FR-07、FR-08、FR-09；门禁：`docs/02-roadmap.md` §3 阶段 6
- 架构：`docs/01-architecture.md` §5.7/§5.10、`docs/03-cli-and-trace.md` 全文
- Commit / Tag：见仓库 `main`
