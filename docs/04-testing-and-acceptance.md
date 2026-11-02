# 04 · 测试与验收

> 状态：已冻结  
> 日期：2026-11-03  
> 关联：[00-requirements.md](./00-requirements.md)、[02-roadmap.md](./02-roadmap.md)、[03-cli-and-trace.md](./03-cli-and-trace.md)

## 1. 测试分层

| 层 | 范围 | 运行环境 | 是否进 CI |
| --- | --- | --- | --- |
| 单元测试 | 纯函数、schema、registry、path guard、redaction、budget | vitest，无网络 | 是 |
| 契约测试 | Provider 流式/tool call/usage/重试；MCP adapter；插件 manifest | 本地 HTTP mock / 本地 MCP server | 是 |
| 图测试 | 单 agent 循环、interrupt/resume、supervisor、swarm、spawn | ScriptedChatModel + 内存 checkpointer | 是 |
| CLI E2E | 命令、REPL、审批、脚本模式、trace viewer | 临时 workspace + 子进程 | 是（离线） |
| Live smoke | 真实 OpenAI 兼容 + Anthropic | 真实 API | 否，手动 |

**硬规则**：

- CI 不调用真实模型，不访问外网（npm 安装除外）。
- 所有 E2E 使用 fake provider + 本地 MCP server + 本地插件。
- trace 断言优先于文本断言；不依赖模型措辞。
- 不以 exit code 0 代替业务断言。

## 2. 测试基础设施

### 2.1 ScriptedChatModel

位置：`@agent-shell/core/testing` 子路径导出。

- 继承 LangChain `BaseChatModel`；
- 按脚本返回 `AIMessage`（含 `tool_calls`）或流式 chunk；
- `.bindTools()` 返回自身，记录可用工具；
- 支持 `usage_metadata`；
- 选择脚本的方式：每个 agent 一个实例（推荐），或按 `config.metadata.agent` 选择；
- 不接受真实网络请求。

**模型脚本格式**（测试用，不是 CLI 协议）：

```json
{
  "version": 1,
  "steps": [
    {
      "toolCalls": [
        { "name": "read_file", "args": { "path": "notes/a.md" }, "id": "call_1" }
      ]
    },
    { "content": "文件内容包含 hello。" },
    { "error": { "name": "ProviderError", "message": "rate limited" } }
  ]
}
```

- 每次模型调用消费一个 step；用尽后抛错（防止测试无限循环）。
- `toolCalls` 的 `name` 必须是注册后的最终名称（含命名空间）。
- 支持 `streamChunks` 字段模拟分片；默认按字符分片。

### 2.2 Provider HTTP mock

- 本地 Node HTTP server 模拟：
  - OpenAI Chat Completions：`POST /v1/chat/completions`，SSE 分片、tool_calls、usage；
  - Anthropic Messages：`POST /v1/messages`，SSE 事件、tool_use、usage。
- 通过 provider 配置的 `baseURL` 指向 `http://127.0.0.1:<port>`。
- 覆盖场景：
  - 正常流式 + tool call；
  - 429 → 重试成功；
  - 500 → 重试耗尽；
  - 超时；
  - 流式中断；
  - usage 缺失（标记 estimated）。
- 该测试证明“真实 SDK + 本地 mock”的协议适配，不证明真实服务行为；真实行为由 live smoke 覆盖。

### 2.3 MCP 测试 server

- `examples/mcp-echo-server`：stdio MCP server，工具：
  - `echo`：只读，回显文本；
  - `write_note`：写入临时目录，风险应为 write/exec（用于审批测试）。
- 测试中作为子进程启动，结束后 `close()`；捕获 stderr。
- 崩溃测试：测试 server 支持 `--crash-on-call` 参数。
- HTTP 传输测试在阶段 4 用 SDK 的 HTTP transport 起本地 server；验收脚本只依赖 stdio。

### 2.4 插件 fixtures

- 合法插件：`examples/file-agent/plugins/word-count`。
- 非法 fixtures（测试专用）：
  - manifest 缺字段；
  - `apiVersion` 不匹配；
  - 入口抛错；
  - 工具重名；
  - 工具缺 risk；
  - 慢工具（超时测试）。
- 断言：坏插件记录 `plugin.error`，shell 继续启动；合法插件可用。

### 2.5 临时 workspace

- 每个 E2E 用 `fs.mkdtemp` 创建独立目录；
- 复制 fixture 文件、插件、MCP server；
- 设置 `HOME`/`XDG_*` 隔离，避免污染真实 `~/.agent-shell`；
- 结束后删除；失败时保留路径并打印，便于排查。

## 3. 各层测试内容

### 3.1 单元

- 配置：默认值、优先级、非法字段、缺 key、命名冲突；
- tool registry：名称规范化、冲突、风险必填、zod 参数校验；
- path guard：`..`、绝对路径、symlink、父目录不存在、大小写/编码边界；
- approval policy：矩阵、allowlist、`--yolo`、硬拒绝、超时、非交互；
- redaction：键名、env 值、headers、嵌套对象、数组；
- event schema：必填字段、版本、span 关联、截断；
- budget：steps/tokens/time/subagents/depth；
- error → exit code 映射。

### 3.2 契约

- OpenAI 兼容 provider：流式、tool call、usage、429/500、超时；
- Anthropic provider：同上；
- MCPAdapter：stdio 列工具/调用、关闭、崩溃、超时、命名；
- 插件 manifest：schema、API 版本、入口解析；
- supervisor/swarm：与固定版本包的 API 契约（编译 + 最小调用）。

### 3.3 图测试

- 单 agent：无工具直接结束；单工具；多轮工具；并行 tool call 顺序执行；达到 maxSteps；取消；
- interrupt：write 一次、exec 两次、拒绝、超时、恢复后状态正确；
- spawn：上下文隔离、工具子集、失败回传、递归拒绝、预算；
- supervisor：路由、`full_history`/`last_message`、worker 失败；
- swarm：handoff、`activeAgent` 跨轮保持、无 checkpointer 报错；
- 事件：run/llm/tool/subagent 层级与 parentSpanId。

### 3.4 CLI E2E

- `run` human/JSON/quiet 三种输出；
- `chat` REPL 命令；
- 审批交互（用伪 TTY 或脚本模式）；
- `sessions list/resume`；
- `trace list/show/tail`；
- `doctor` 缺 key/坏插件/不可达 MCP；
- 退出码；
- 脚本模式无 TTY 运行。

### 3.5 Live smoke（手动）

> 步骤手册、通过标准与记录格式见 [live-smoke.md](./live-smoke.md)。

- 前置：`OPENAI_API_KEY`、可选 `OPENAI_BASE_URL`、`ANTHROPIC_API_KEY`。
- 步骤：
  1. `agent-shell doctor --probe`；
  2. OpenAI 兼容 provider：一次普通对话；
  3. 一次 read 工具（自动）；
  4. 一次 write 工具（批准）；
  5. 一次 exec 工具（两次确认）；
  6. 一次 spawn 子 agent；
  7. 切 Anthropic：一次普通对话 + 一次工具调用；
  8. `trace show` 检查 provider、usage、审批、子 agent；
  9. 确认 trace 无 key、无 headers。
- 记录：日期、模型 ID、run ID、结果；**不记录 key**。
- 成本提示：默认用最小模型、短 prompt；不要跑长循环。

## 4. 单一端到端验收剧本

> 这是首期唯一官方验收剧本。`pnpm acceptance` 在离线环境执行全部 Acts；任何一步失败即验收失败。

### 4.1 前置

- fake provider：`openai:fake`、`anthropic:fake` 均映射到 ScriptedChatModel；
- 临时 workspace：`notes/a.md` 内容 `hello world`；`notes/b.md` 内容 `agent shell`；
- 插件：`word-count`；
- MCP：本地 echo server；
- 文件工具：`read_file`、`write_file`、`run_shell`（仅允许 `echo`）；
- agents：`researcher`（只读工具）、`writer`（读写工具）；
- presets：`single`、`team`（supervisor：researcher + writer）、`swarm`（researcher ↔ writer）。

### 4.2 Acts

| Act | 操作 | 预期能力 |
| --- | --- | --- |
| 1 | `run --provider openai:fake "读取 notes/a.md 并总结"` | code tool read、自动放行、run/llm/tool 事件 |
| 2 | 同一会话调用 `word_count` 插件工具 | plugin.loaded、plugin 工具、命名空间 |
| 3 | 同一会话调用 MCP `echo` | mcp.connected、MCP 工具调用 |
| 4 | 请求写 `notes/summary.md` | write 审批 1 次、批准后文件存在 |
| 5 | 请求 `run_shell echo hello` | exec 审批 2 次（attempt=1/2）、输出 hello |
| 6 | 请求 spawn `researcher` 读取 `notes/b.md` | subagent.started/finished、独立 span、只读工具子集 |
| 7 | 切换 `anthropic:fake` 做一次总结 | 双 Provider 路由、llm.started 记录 anthropic |
| 8 | `run --preset team "总结两个文件"` | supervisor 路由、handoff 事件、worker span |
| 9 | `run --preset swarm "先研究再写摘要"` 连续两轮 | swarm handoff、activeAgent 跨轮保持 |
| 10 | 退出后 `sessions resume <id>` | checkpoint 恢复、历史保留 |
| 11 | `trace show <run-id>` + `--json` | 树形回放、NDJSON 可解析 |
| 12 | 注入 fake secret，检查 trace/config | 脱敏、无泄漏 |

### 4.3 断言

**退出码**：

- 所有 Act 退出码 0；预期失败的子用例单独断言非 0。

**输出**：

- Act 1 最终答案包含 `hello`；
- Act 4 文件 `notes/summary.md` 存在且内容匹配；
- Act 5 工具输出包含 `hello`；
- Act 6 父答案包含子 agent 的结论；
- Act 8/9 输出包含各 worker 的结果。

**trace 事件覆盖**：

- `run.started` / `run.finished` 成对出现，status=ok；
- `llm.started` 同时出现 `openai` 与 `anthropic`；
- `tool.started` 覆盖来源 `code`、`plugin`、`mcp`；
- `tool.approval.requested`：write 1 次；exec 2 次；`attempt` 分别为 1 和 2；
- `tool.approval.decided` 与 requested 一一对应；
- `subagent.started` 覆盖 `spawn`、`supervisor`、`swarm`；
- `subagent.handoff` 至少出现 2 次（supervisor + swarm）；
- 所有子 span 有 `parentSpanId`；spawn depth=1，嵌套不超过 2；
- 工具最终名称符合命名空间规则（`plugin__`、`mcp__`）；
- `session.resumed` 出现在 Act 10。

**安全**：

- trace 全文不包含 fake secret；
- `config` 导出不包含 key；
- 未匹配的 write/exec 在脚本模式下被拒绝且测试失败（单独用例）；
- 非交互无脚本时 write/exec 被拒绝（单独用例）；
- `../`、绝对路径越界、symlink 逃逸被拒绝（安全用例）；
- `--yolo` 下硬拒绝命令仍被拒绝（安全用例）。

**架构**：

- 静态检查：`packages/core` 不 import `examples/`；
- `packages/cli` 不直接构造 `ChatOpenAI` / `ChatAnthropic` / `MCPAdapter`；
- 事件 schema 校验器接受全部 trace 行；
- `trace show --json` 输出可被 JSON 解析。

### 4.4 命令

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm acceptance
pnpm build
```

`pnpm acceptance` 内部等价于一个 runner：

1. 建临时 workspace；
2. 启动本地 MCP server；
3. 写 `scenario.acceptance.json` 与 `model.script.json`；
4. 依次执行 Acts；
5. 解析 trace 并断言；
6. 清理；失败时保留目录并打印路径。

## 5. CI 门禁

| 门禁 | 命令 | 失败即阻止合并 |
| --- | --- | --- |
| 安装 | `pnpm install --frozen-lockfile` | 是 |
| 静态检查 | `pnpm lint` | 是 |
| 类型 | `pnpm typecheck` | 是 |
| 单元/契约/图 | `pnpm test` | 是 |
| 离线验收 | `pnpm acceptance` | 是 |
| 构建 | `pnpm build` | 是 |

- 不跑 live smoke；不在 CI 注入真实 key。
- 缓存 pnpm store；禁止测试访问外部 URL。
- 依赖锁文件变更需在 PR 中单独说明。

## 6. 覆盖率与质量

- `packages/core` 行覆盖率 ≥ 80%；
- 以下模块必须有拒绝路径测试，不以覆盖率替代：
  - approval policy；
  - path guard；
  - tool registry 名称/冲突；
  - config 校验；
  - redaction；
  - event schema。
- CLI 以 E2E 为主，不设覆盖率门槛。
- 禁止用 snapshot 替代行为断言。
- 禁止用 retry 掩盖 flaky test；48 小时内修复或隔离并记录。

## 7. 验收记录

阶段 7 结束后，在 `docs/phases/07-acceptance.md` 记录：

- `pnpm acceptance` 输出摘要；
- 关键 run ID 与 trace 路径；
- live smoke 日期、模型、结果；
- 未覆盖项/已知限制；
- 与 00 的 AC-1..AC-5 对照表。

模板见 [docs/phases/TEMPLATE.md](./phases/TEMPLATE.md)。
