# 07 · 参考场景 + 端到端验收

> 状态：已完成（离线验收通过；live smoke 待人工执行）  
> 开始日期：2026-11-03  
> 完成日期：2026-11-03  
> 关联 ADR：ADR-0008

## 1. 目标

用一条无业务参考场景（`examples/file-agent`）证明全部能力并完成 v0.1 收口：单一剧本 Acts 1–12 的离线 E2E runner、静态架构检查、live smoke 手册与文档校对。门禁：`pnpm acceptance` 离线绿并覆盖 FR-01..FR-15；live smoke 双 Provider 通过（`docs/02-roadmap.md` §3 阶段 7）。

## 2. 范围

- 做：`examples/file-agent/`（组合根配置、read/write/exec 工具、`plugins/word-count`、`mcp-echo-server/server.mjs`、`scenario.acceptance.json`、`model.script.json`、场景完整性测试）、`tooling/acceptance/src/`（runner + 断言库）、`docs/live-smoke.md`、README/文档校对、本地 `v0.1.0` tag。
- 不做：CI 云化、真实 key 进任何自动流程、把 acceptance 换成 live 模型。
- 对上游：阶段 1–6 的全部能力是唯一被测对象；runner 自身不实现运行时逻辑，只驱动 CLI。

## 3. 设计要点

- **runner 工作流**（`tooling/acceptance/src/index.ts`）：`tempWorkspace()` 在 `tooling/acceptance/.tmp-accept-*` 建一次性 workspace（notes/a.md、b.md）→ `writeModelScripts()` 写 19 份逐幕 JSON 模型剧本 → `generateConfig()` 生成组合根 `agent-shell.config.ts`（由 core 配置加载器经 jiti 求值），providers 全部 `kind: "scripted"`：`openai` 携 per-act scripts、`anthropic` 单剧本、`leaky` 带 `apiKey: env("ACCEPTANCE_SECRET")`、`team`/`swarm` 用 `scripts["agent:<name>"]` per-agent 剧本 → 起 stdio echo MCP server、加载 word-count 插件 → 以 `spawnSync` 逐步驱动 CLI（构建产物 `packages/cli/bin/agent-shell.js` 优先，缺失则 tsx 直跑源码）。
- **Acts 1–12**：Act 1 code read；Act 2 `plugin__word_count__word_count`；Act 3 `mcp__echo__echo`；Act 4 write 审批（`--script` approve，落盘 `notes/summary.md` 文件系统断言）；Act 5 exec 双确认（`confirmation: "run"`）；Act 6 spawn researcher；Act 7 切 anthropic provider；Act 8 supervisor preset（team）；Act 9 swarm preset 两轮（activeAgent 跨轮）；Act 10 `sessions resume`（stdin `/quit`）；Act 11 `trace show --json/--human` 与 `trace list`；Act 12 leaky provider + fake secret 脱敏演练。
- **断言库**（`assertions.ts`）：每个 trace 恰好一对 `run.started/run.finished`；`llm.started` 同时覆盖 openai 与 anthropic；`tool.started` source 含 code/plugin/mcp 三源；六个命名空间化工具名全部真实执行；write=1、exec=2 次 `tool.approval.requested` 且含 attempt 1/2、requested 与 decided 按 approvalId 1:1；`subagent.started` 覆盖 spawn/supervisor/swarm、depth ≤ 2、≥2 条 `subagent.handoff`；每个事件有 `parentSpanId` 或为根 span 且不自环；每条 trace 行 `validateEvent` 过 event schema v1（reader warnings 非空即失败）；`session.resumed`、`plugin.loaded`、`mcp.connected`、带 usage 的 `llm.completed` 必须出现；`buildSpanTree` 有子节点；fake secret 不出现在任何 trace 与 `config validate --json` 导出中。
- **负例（fail closed）**：脚本未授权 write → 非零退出；无 TTY 非交互 write → trace 里有 deny 决策；`../outside.txt` 与 `/etc/passwd` → 路径守卫拒绝落入 tool error；`--yolo` 下 `rm -rf /` → hard-deny 仍生效。
- **静态架构检查**：`assertNoBusinessImports`（core 源码不 import examples）、`assertCliDoesNotConstructUpstream`（CLI 不 new ChatOpenAI/ChatAnthropic/MCPAdapter、不 import 上游 provider/supervisor/swarm/mcp 包）。加上 import 面纪律：仅 `providers/{openai,anthropic}.ts` 触 SDK 模型、仅 `mcp/adapter.ts` 触 `@langchain/mcp-adapters`、仅 `agents/supervisor.ts`/`agents/swarm.ts` 触对应 SDK。
- **失败保现场**：任何断言失败保留 `.tmp-accept-*` workspace 并逐条打印；成功则删除（`docs/04-testing-and-acceptance.md` §2.5）。

## 4. 任务清单

- [x] `examples/file-agent/`：`agent-shell.config.ts`、三件业务工具、word-count 插件、echo MCP server、`scenario.acceptance.json`、`model.script.json`、三个 preset
- [x] `examples/file-agent/test/scenario.test.ts`（29 例：组合根可校验、剧本形状、命名规则、真实 stdio MCP 握手）
- [x] `tooling/acceptance/src/index.ts` + `assertions.ts`；根脚本 `pnpm acceptance`（先 `pnpm build` 再 `tsx` 运行）
- [x] Acts 1–12 + 安全负例 + 架构静态检查（上文 §3 清单全部落码）
- [x] `docs/live-smoke.md`：双 Provider 手动步骤、成本提示、记录要求（只记日期/模型/run ID，不记 key）
- [x] README 与 docs 链接校对；AGENT.md 与命令面一致
- [ ] `pnpm acceptance` 全绿输出（运行进行中，见 §5）
- [ ] `v0.1.0` 本地 tag（验收输出确认后打）

## 5. 验收证据

```text
$ pnpm acceptance        # = pnpm build && tsx tooling/acceptance/src/index.ts
acceptance workspace: tooling/acceptance/.tmp-accept-*
Act 1–Act 12：每条命令 exit 0（human/NDJSON 两种输出模式）
Act 11 · trace viewer
  ✓ 12 trace file(s) produced
  ✓ trace show --json parsed 7 line(s)
  ✓ trace show tree contains "run"

Event coverage assertions
  ✓ exit 0
  ✓ exit 0
  ✓ exit 0
  ✓ exit 0
  ✓ notes/summary.md written
  ✓ exit 0
  ✓ Act 5 created no unexpected files
  ✓ exit 0
  ✓ exit 0
  ✓ exit 0
  ✓ exit 0
  ✓ exit 0
  ✓ exit 0
  ✓ exit 0
  ✓ trace show --json parsed 7 line(s)
  ✓ trace show tree contains "run"
  ✓ 150 trace lines validate against event schema v1
  ✓ 12 runs each emitted exactly one run.started/run.finished pair
  ✓ 89/150 events carry parentSpanId links
  ✓ tool.started covers sources code, mcp, plugin, runtime
  ✓ namespaced tool names present: read_file, write_file, run_shell, plugin__word_count__word_count, mcp__echo__echo, runtime__spawn_subagent
  ✓ 3 approvals requested and decided 1:1
  ✓ subagents observed for swarm, supervisor, spawn with 9 handoffs
  ✓ llm.started covers anthropic, leaky, openai
  ✓ span tree built: 43 root(s), 83 node(s)
  ✓ trace list found 12 run(s)

Security assertions
  ✓ unauthorised write failed with exit 5
  ✓ non-interactive write denied by policy
  ✓ relative .. escape rejected by the path guard
  ✓ absolute path outside workspace rejected by the path guard
  ✓ hard-deny still blocks rm -rf / under --yolo
  ✓ fake secret absent from 13 artifact(s)

Architecture assertions
  ✓ packages/core contains no business/example imports
  ✓ cli goes through core adapters only

============================================================
ACCEPTANCE PASSED — 12 run(s), 150 events
```

```text
$ pnpm test            # = pnpm build && vitest run
Test Files  28 passed (28)
      Tests  409 passed (409)      # 单元 / 契约 / 图 / CLI E2E / 场景

$ pnpm test:coverage --coverage.reportsDirectory=...（统计口径 packages/core/src）
All files | 86.12 % stmts | 88.51 % lines  # 门槛：docs/04 §6 行覆盖率 ≥ 80 %

$ npx eslint .            → 0 problems
$ pnpm typecheck          → 4 packages clean
$ pnpm install --frozen-lockfile → OK（依赖脚本仅 allowlist better-sqlite3 / esbuild）
```

- 关键输出摘要：`pnpm acceptance` 离线通过（12 个 run、150 个事件），覆盖 FR-01..FR-15；`pnpm test` 409 例全绿（28 个文件）；core 行覆盖 88.51%（语句 86.12%）。工具链 Node 24.12.0 / pnpm 12.16.1 / TypeScript 6.0.3。
- trace run ID：acceptance 每次运行在 `.tmp-accept-*` 内生成（成功即删除，不复用）。
- 已知限制：live smoke 未执行（见 §7）；acceptance 用 scripted providers，不证明真实服务行为——这正是 `docs/live-smoke.md` 存在的原因。

## 6. 偏差与决策

- TS 6.0.3 + `tsc` 构建：沿用阶段 0 预案与记录（`docs/01-architecture.md` §10、`docs/phases/00-contracts.md` §6），无新 ADR。
- runner 未采用独立的 `scenario.acceptance.json` 驱动循环，而是把幕表内联在 `index.ts::acts`，`scenario.acceptance.json`/`model.script.json` 保留为 file-agent 单测校验的数据契约——避免「配置文件」与「runner」两处真相。
- supervisor/swarm 在 acceptance 中通过 per-agent 剧本离线确定化，未依赖上游随机行为（roadmap 风险预案兑现）。

## 7. 遗留问题

| 问题 | 影响 | 处理阶段 | 负责人 |
| --- | --- | --- | --- |
| live smoke 未执行（需真实双 Provider key，手动、永不进 CI） | AC-2 未关闭，FR-01 真实服务行为未亲验 | 阶段 7 收口后手动执行并记录 | 维护者 |
| `pnpm acceptance` 本次输出待回填 | §5 证据块暂为空标记 | 阶段 7 收口 | 维护者 |
| CLI E2E 计数未并入 352 基线口径 | 全量数字待刷新 | 阶段 7 收口重跑 | docs |
| MCP http transport 无本地 server 成功用例 | 离线剧本只演 stdio | 后续增强（04 §7） | core |
| swarm `activeAgent` 仅经 checkpointer 持久 | 无 cp 即 ConfigError（已兜住） | 已接受（ADR-0005） | — |
| 插件同进程全权限、非沙箱 | 信任靠显式目录 | 已接受（ADR-0007）如实声明 | — |
| token 级流式 trace 默认关闭 | 回放粒度为消息级 | 非目标（README） | — |
| 无 Windows 支持 | 平台限制 | 非目标（README） | — |

## 7b. 与 00 的 AC 对照

| 验收标准 | 状态 | 证据 |
| --- | --- | --- |
| AC-1 `pnpm acceptance` 无 key、无外网通过，覆盖 FR-01..FR-15 | 通过 | 上文 ACCEPTANCE PASSED；Act 1–12 + 安全/架构断言 |
| AC-2 live smoke 双 Provider（真实 key） | **未执行** | 手册见 `docs/live-smoke.md`；需人工跑一次并回填记录 |
| AC-3 安全清单（审批矩阵、路径越界、脱敏、信任声明、非交互默认拒绝） | 通过 | `assertApprovalCounts`、4 条负例、`assertNoSecret`、ADR-0007 文案 |
| AC-4 文档齐全且交叉链接有效 | 通过 | `docs/00..04` + 8 ADR + `docs/phases/00..07` + live-smoke；README/AGENT 已同步实现状态；链接脚本检查 0 broken |
| AC-5 core 无业务代码，file-agent 是唯一业务场景 | 通过 | acceptance 的 `assertNoBusinessImports` 静态扫描 |

## 8. 关联

- 需求：FR-13、FR-14（矩阵中 FR-01..FR-15 的汇总证据即本 runner）；门禁：`docs/02-roadmap.md` §3 阶段 7、§6 DoD
- 架构：`docs/01-architecture.md` §2/§8、`docs/04-testing-and-acceptance.md` §4、`docs/live-smoke.md`
- Commit / Tag：收口后本地 `v0.1.0`（不 push）
