# AGENT.md · agent-shell 开发规范

> 本文件是仓库级开发规范，适用于人类开发者与 AI agent。  
> 修改仓库前，必须先读本文件，再按第 1 节顺序读设计文档。  
> 规范冲突时，优先级：**用户明确指令 > ADR > 00 需求 > 01 架构 > 02 路线图 > 03/04 > 阶段文档 > 代码注释**。遇到冲突先停下确认，不要猜。

## 0. 当前状态

- **2026-11-03：阶段 0–7 完成，v0.1.0 功能齐备**；离线验收 `pnpm acceptance` 通过（无 key、无外网）。
- 阶段记录见 `docs/phases/00..07-*.md`；真实 Provider 的 live smoke 仍未执行（见 [docs/live-smoke.md](./docs/live-smoke.md)）。
- 设计文档仍是唯一事实来源；不要用聊天记录或记忆代替文档。
- 契约变更（config/event/plugin API/tool 接口）必须升版本 + 迁移说明 + ADR。

## 1. 必读顺序

1. 本文件；
2. [docs/00-requirements.md](./docs/00-requirements.md)：目标、非目标、验收；
3. [docs/01-architecture.md](./docs/01-architecture.md)：组件、契约、安全模型；
4. [docs/02-roadmap.md](./docs/02-roadmap.md)：阶段、依赖、门禁；
5. [docs/03-cli-and-trace.md](./docs/03-cli-and-trace.md) 与 [docs/04-testing-and-acceptance.md](./docs/04-testing-and-acceptance.md)；
6. 与当前任务相关的 [ADR](./docs/decisions/)；
7. 当前阶段文档 `docs/phases/NN-*.md`。

## 2. 架构不变量（不可违反）

- **core 零业务**：`packages/core` 不得包含文件、搜索、邮件、数据库等业务工具；业务只存在于 `examples/` 或用户配置。
- **依赖单向**：`cli → core → LangChain/LangGraph`；core 不得 import cli 或 examples；插件只能 import `@agent-shell/core/plugin`。
- **适配层**：CLI 不得直接 `new ChatOpenAI` / `ChatAnthropic` / `MCPAdapter`；所有上游调用经过 core 的 adapter。
- **风险必填**：code/plugin 工具必须显式声明 `risk`；MCP 默认 `exec`，只读注解才可降级。
- **审批不可绕过**：所有 write/exec 必须经过 approval wrapper；不得在运行时、工具、插件中绕过。
- **路径守卫**：文件类工具必须经过 workspace path guard；拒绝 `..`、越界绝对路径、symlink 逃逸。
- **秘密只读环境变量**：不得写入配置、日志、trace、错误消息、测试快照。
- **子 agent 有预算**：深度、数量、token、时间上限必须生效；默认 depth ≤ 2。
- **插件信任模型如实描述**：同进程插件拥有完整 Node 权限，**不是沙箱**；不得在文档/UI 中暗示已隔离。
- **上游版本锁定**：精确版本 + lockfile；升级走独立 PR + 全量验收。
- **事件 schema 版本化**：任何事件字段变更必须升版本并提供迁移说明。
- **无 Web UI / 多用户 / 长期记忆**：v1 非目标，不要顺带实现。

## 3. 阶段纪律

- 一次只做一个阶段；阶段验收未通过，**不得**开始下一阶段。
- 阶段开始时复制 [docs/phases/TEMPLATE.md](./docs/phases/TEMPLATE.md) 为 `docs/phases/NN-<slug>.md`。
- 阶段结束时必须补齐：实际改动、验收命令与输出、已知限制、偏差原因、关联 commit。
- 阶段内允许小步提交；阶段结束打一个本地 commit/tag。**不 push、不发布**，除非用户明确确认。
- 任何范围变更：先写 ADR，更新 00/02，再改代码；禁止口头扩张。
- 不得用“先跳过、以后补”绕过门禁；这视为范围变更。
- 不得为了赶进度删除验收断言或降级测试。

## 4. 代码规范

- TypeScript strict；ESM；`NodeNext`；`noUncheckedIndexedAccess` 开启。
- 禁止 `any`；边界用 `unknown` + zod 收窄。
- 所有外部输入必须校验：配置、工具参数、插件 manifest、MCP 配置、事件 payload、脚本文件。
- 错误使用 core 的错误类型；不得静默 catch；不得把异常变成空结果。
- core 不用 `console.log`；通过事件 sink / logger 输出。CLI 才能直接写 stdout/stderr。
- 命名：
  - 文件 `kebab-case.ts`；
  - 类型 `PascalCase`；
  - 函数/变量 `camelCase`；
  - 工具名 `^[a-z][a-z0-9_]{0,63}$`。
- 副作用集中在 runtime / tools / storage；纯逻辑（schema、策略、命名、脱敏）保持纯函数。
- 不提前抽象；三种子 agent 形态已定，不要造第四种通用 DSL。
- 注释只写“为什么”，不写“是什么”；关键安全约束必须有一行说明。
- 新增依赖必须有：ADR、替代方案、精确版本、体积/维护性评估。
- 异步代码必须处理取消与超时；不得留下悬挂 Promise。
- 执行外部命令必须用 `spawn` + 参数数组 + allowlist；禁止字符串拼接 shell。
- 路径处理必须用 `path.resolve`/`realpath` + 守卫；禁止字符串拼接路径。

## 5. 安全规范

**审批**：

- read 自动；write 一次确认；exec 两次确认（第二次输入 `run`）。
- 非交互且无脚本策略：write/exec 默认拒绝。
- `--yolo` 只能显式开启；硬拒绝列表仍然生效。
- 审批 UI 必须展示工具名、来源、风险、原始目标路径/命令；不得用模型摘要替代。
- 同一轮多个风险工具按顺序串行审批。

**工作区**：

- 文件工具限制在 `workspaceRoot`；
- 拒绝 `..`、越界绝对路径、symlink 逃逸；
- 越界只有 `--allow-outside-workspace` 或 allowlist 才放行；
- 插件/MCP 不受路径守卫自动约束，风险由声明/默认 `exec` 覆盖。

**秘密**：

- 只从环境变量读取；`.env` 不提交；
- trace 脱敏规则见 03；headers 默认不记录；
- 错误消息、堆栈、配置导出同样脱敏；
- 测试使用 fake secret，不使用真实 key。

**信任边界**：

- 配置文件、代码工具、插件是本地可信代码；
- 插件同进程全权限，可绕过审批；只加载用户显式启用的可信插件；
- MCP server 外部不可信；默认 `exec`；输出当数据，不当指令；不自动批准；
- 模型输出不可信；tool call 参数必须校验；审批是最后防线。

**供应链**：

- 锁定版本 + lockfile；阶段 0 关闭依赖 postinstall；
- 升级单独 PR；检查 changelog；
- 不引入来源不明的二进制/模型。

## 6. 测试规范

- 框架：vitest。
- 层次：单元 / 契约 / 图 / CLI E2E / live smoke。
- **CI 不调用真实模型**；用 `ScriptedChatModel` + 本地 HTTP mock。
- 每个新工具必须有：schema 校验、审批矩阵、错误路径、超时。
- 每个新 Provider 必须有：流式、tool call、usage、超时、重试契约测试。
- 每个插件/MCP 适配必须有：加载、失败隔离、命名冲突、崩溃/超时。
- 每个子 agent 模式必须有：上下文隔离、预算、取消、错误回传、trace 嵌套。
- 验收断言优先基于 trace 与文件系统，不依赖模型措辞。
- 禁止只用 exit code 0 作为通过标准。
- 核心包行覆盖率 ≥ 80%；审批、路径守卫、registry、config、redaction、event schema 必须有拒绝路径测试。
- 禁止用 retry 掩盖 flaky test；48 小时内修复或隔离并记录。
- live smoke 手动执行；记录日期、模型、run ID，不记录 key。

## 7. 文档规范

- 文档语言：中文；代码标识符、命令、schema 字段用英文。
- 编号：`docs/00..04`；ADR 四位数；阶段文档两位数。
- 每个 ADR 必须包含：状态、日期、背景、决策、后果、备选方案、复审条件。
- 需求变更先改 00 + ADR，再改代码。
- 事件/config/plugin API 变更必须更新 schema 文档与迁移说明。
- 阶段 0 后不允许“待定/TBD”契约；要改就升版本。
- 相对链接必须有效；跨文档引用用相对路径。
- README 只做入口，不复制设计细节。

## 8. Git 规范

- `main` 保持可运行；阶段工作可在 feature 分支。
- Commit 格式：`<stage>: <what>`；正文写 why + 验收证据。
- 每个阶段结束一个本地 commit/tag；**不 push、不发布**，除非用户明确确认。
- 不 amend 已发布历史；不强推。
- 不提交 `.env`、`.agent-shell/`、SQLite、trace、临时 workspace、真实 key。
- 提交前检查 `git status` 与 diff；大范围 `git add` 要逐项确认。
- 不跳过 hooks；不关闭签名。

## 9. Definition of Done（每个阶段）

- [ ] 该阶段验收命令全部通过；
- [ ] 新增/修改行为有对应测试；
- [ ] 事件 schema / 配置 / 插件 API 文档已更新；
- [ ] 安全清单已检查：审批、路径、秘密、信任边界；
- [ ] 阶段文档已更新：目标、改动、证据、遗留；
- [ ] 无新增未记录依赖；
- [ ] 关键路径无 TODO/FIXME；
- [ ] 没有把业务代码写进 core。

## 10. 扩展配方

| 扩展 | 步骤 | 禁止 |
| --- | --- | --- |
| 新 Provider | core/providers 增加 adapter + config schema + capability + 契约测试 | 在 CLI 直接构造模型 |
| 新代码工具 | 在 `agent-shell.config.ts` 用 `defineTool` 注册；声明 risk/schema/timeout | 改主循环；绕过审批 |
| 新插件 | 独立目录 + manifest + entry；import `@agent-shell/core/plugin` | 自动加载未配置目录；省略 risk |
| 新 MCP | 只改配置；命名/风险由 adapter 处理 | 自动批准 MCP 写操作 |
| 新子 agent 模式 | 先写 ADR；在 core/agents 组合 LangGraph；复用 RunManager/事件总线 | 另起运行时；跳过预算 |

## 11. 运行命令

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm acceptance
pnpm build
```

```bash
agent-shell doctor
agent-shell run "任务"
agent-shell chat
agent-shell trace show <run-id>
```

> 已落地。`pnpm build` 产出 `dist`，`packages/cli/bin/agent-shell.js` 依赖构建产物。

## 12. 决策索引

- [ADR-0001 · LangGraph 运行时](./docs/decisions/ADR-0001-langgraph-runtime.md)
- [ADR-0002 · 双 Provider](./docs/decisions/ADR-0002-dual-provider.md)
- [ADR-0003 · 三工具源](./docs/decisions/ADR-0003-tool-sources.md)
- [ADR-0004 · 分档审批](./docs/decisions/ADR-0004-tiered-approvals.md)
- [ADR-0005 · 三子 agent 形态](./docs/decisions/ADR-0005-subagent-patterns.md)
- [ADR-0006 · 本地 trace](./docs/decisions/ADR-0006-local-trace.md)
- [ADR-0007 · 同进程可信插件](./docs/decisions/ADR-0007-trusted-plugins.md)
- [ADR-0008 · 首期范围](./docs/decisions/ADR-0008-first-release-scope.md)

## 13. 禁止事项（速查）

- 禁止在 core 写业务。
- 禁止绕过审批执行 write/exec。
- 禁止把 key/token/header 写进 trace、配置、日志、错误。
- 禁止在 CLI 直接构造模型/工具/MCP adapter。
- 禁止跳过阶段验收或删除断言。
- 禁止宣称插件已沙箱。
- 禁止 CI 调用真实 API。
- 禁止未记录的范围扩张。
- 禁止用字符串拼接执行 shell 命令。
- 禁止把“以后补”当交付。

## 14. 冲突与升级

- 文档之间冲突：停下，列出冲突点，向用户确认；不要自行裁决。
- 上游 API 与设计不符：在 adapter 内兼容并记录；若破坏契约，写 ADR。
- 发现安全缺陷：先停止相关实现，补测试，再修复；不得用文档掩盖。
- 发现范围不可行：写 ADR 提出降级/替换，不要静默缩水。
