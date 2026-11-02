# 00 · 契约与骨架

> 状态：已完成  
> 开始日期：2026-11-03  
> 完成日期：2026-11-03  
> 关联 ADR：ADR-0001..0008

## 1. 目标

在任何业务/模型代码之前，冻结工程骨架与四套契约：config schema v1、event schema v1、plugin API v1、tool 接口 v1，并验证工具链兼容性。

## 2. 范围

- 做：pnpm workspace（`packages/core`、`packages/cli`、`examples/file-agent`、`tooling/acceptance`）、TS strict + ESM + NodeNext、eslint/prettier/vitest、`.nvmrc`/`packageManager`/`.gitignore`、四套 schema、错误类型与退出码映射、CLI 入口约定。
- 不做：模型调用、工具执行、子 agent、插件加载、MCP 连接（阶段 1–4）。
- 对下游：所有阶段只能通过这些契约交流；改字段必须升版本。

## 3. 设计要点

- **秘密是惰性引用**：`env("OPENAI_API_KEY")` 返回 `{ $secret: "env", variable }`，配置对象被序列化（`/config`、`config validate`、trace、错误）时只会出现变量名，不可能出现值。
- **事件 payload 逐类型 `.strict()`**：`EVENT_PAYLOAD_SCHEMAS` 对 26 类事件分别校验 payload 键，多余键直接失败，使 schema 漂移在读取 trace 时立刻暴露。
- **风险与命名空间**：`plugin__<plugin>__<tool>` / `mcp__<server>__<tool>` / `runtime__<tool>` 用双下划线分隔，单个下划线不可能伪造命名空间；code/plugin 缺 `risk` 直接拒绝注册。
- **审批顺序**：硬拒绝列表先于 `--yolo` 求值（`evaluateApproval`），非交互默认拒绝。
- **工具链**：TypeScript 7.0.2 与 `typescript-eslint@8.72.1` 的 peer 区间 `>=4.8.4 <6.1.0` 冲突，npm/pnpm 均拒绝解析，按本文档预案回退 6.0.3（已在 `docs/01-architecture.md` §10 记录）。

## 4. 任务清单

- [x] pnpm workspace + 4 个成员包骨架
- [x] TS strict（`noUncheckedIndexedAccess`）、ESM、NodeNext
- [x] eslint flat config + prettier + vitest（含 80% core 行覆盖门槛）
- [x] `agent-shell.config.ts` zod schema（providers/defaults/workspaceRoot/tools/plugins/mcp/agents/presets/approvals/limits/trace/checkpointer）
- [x] 事件 schema v1（信封 + 26 类事件 payload + 校验器）
- [x] 插件 manifest schema v1 与 `PLUGIN_API_VERSION`
- [x] 错误类型 + 退出码映射（0/1/2/3/4/5/6/130）
- [x] CLI/trace 路径约定（`.agent-shell/state.sqlite`、`.agent-shell/traces/<ses>/<run>.jsonl`）
- [x] 工具链兼容性验证并记录回退决策

## 5. 验收证据

```text
$ node -v && pnpm -v
v24.12.0
12.16.1

$ npm i typescript@7.0.2 typescript-eslint@8.72.1
npm error peer typescript@">=4.8.4 <6.1.0" from typescript-eslint@8.72.1   # → 回退 6.0.3

$ pnpm install --frozen-lockfile
Scope: all 5 workspace projects
Done（依赖 postinstall 默认关闭，仅 allowlist better-sqlite3 / esbuild）

$ pnpm typecheck        # 见 §7：仅核心包，阶段 1+ 逐包扩展
$ pnpm test
```

- 关键输出摘要：契约层无类型错误；`pnpm approve-builds better-sqlite3 esbuild` 后原生模块可用。
- trace run ID：阶段 0 不产生 run。
- 已知限制：`agent-shell --help` / `doctor` 骨架在阶段 6 落地为完整命令面。

## 6. 偏差与决策

- TypeScript 7.0.2 → 6.0.3：工具链不兼容，`docs/02-roadmap.md` §3 阶段 0 已预案「不兼容则回退 6.0.x」，无需新 ADR，已在 `docs/01` §10 更新版本表。
- 构建用 `tsc`（非 tsup）：`tsc` 已能产出 ESM + `.d.ts` 供插件作者使用，少一个依赖即少一个供应链面；`pnpm build` 仍成立。
- 新增 `@agent-shell/core` 的 `tooling/acceptance` 工作区成员：验收 runner 需要一个不属于业务示例的位置。

## 7. 遗留问题

| 问题 | 影响 | 处理阶段 | 负责人 |
| --- | --- | --- | --- |
| 阶段 0 只冻结契约，无运行时 | `pnpm acceptance` 尚无被测实现 | 阶段 1–7 | — |
| LangGraph `interrupt()` 在节点重放时会重跑副作用 | 若工具副作用先于审批，会重复执行 | 阶段 2：审批前置为纯函数 pass | core |

## 8. 关联

- 需求：FR-10、FR-16；AC-4
- 架构：`docs/01-architecture.md` §5.4/§5.5/§5.9/§6/§10、`docs/03-cli-and-trace.md` §6/§7/§10
- Commit / Tag：见仓库 `main`（阶段 7 结束打 `v0.1.0`）
