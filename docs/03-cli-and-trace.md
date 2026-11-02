# 03 · CLI 与 Trace 规范

> 状态：设计基线，阶段 0 冻结  
> 日期：2026-11-03  
> 关联：[01-architecture.md](./01-architecture.md)、[ADR-0006](./decisions/ADR-0006-local-trace.md)

## 1. CLI 命令面

二进制名：`agent-shell`。

| 命令 | 作用 | 关键参数 |
| --- | --- | --- |
| `agent-shell chat` | 进入 REPL（默认命令） | `--session`、`--preset`、`--provider`、`--config` |
| `agent-shell run <task>` | 单次执行 | `--preset`、`--provider`、`--json`、`--quiet`、`--script` |
| `agent-shell trace list` | 列出 run | `--session`、`--json` |
| `agent-shell trace show <run-id>` | 树形回放 | `--json`、`--raw` |
| `agent-shell trace tail <run-id>` | 跟随事件 | `--json` |
| `agent-shell tools list` | 列出已注册工具 | `--source code\|plugin\|mcp`、`--json` |
| `agent-shell plugins list` | 列出插件及状态 | `--json` |
| `agent-shell mcp list` | 列出 MCP server 与工具 | `--json` |
| `agent-shell mcp status` | 查看连接状态与最近错误 | `--json` |
| `agent-shell providers list` | 列出 provider/模型/能力 | `--json` |
| `agent-shell sessions list` | 列出会话 | `--json` |
| `agent-shell sessions resume <id>` | 恢复会话并进入 REPL | `--preset`、`--provider` |
| `agent-shell doctor` | 诊断配置/密钥/插件/MCP | `--probe`、`--json` |
| `agent-shell config validate` | 只校验配置 | `--json` |

**全局参数**：

- `--config <path>`：指定配置文件；默认发现顺序见 01。
- `--workspace <path>`：覆盖 workspaceRoot。
- `--trace-dir <path>`：覆盖 trace 目录。
- `--provider <provider:model>`：覆盖默认模型。
- `--preset <name>`：选择运行预设。
- `--yolo`：跳过审批（硬拒绝仍生效）。
- `--allow-outside-workspace`：允许文件工具越界。
- `--no-color`、`--verbose`、`--json`。
- `--script <file>`：脚本化运行（见第 5 节）。

**stdout / stderr 约定**：

- 结果、NDJSON 事件写 stdout；
- 诊断、进度、错误写 stderr；
- `--json` 下 stdout 只允许 NDJSON，不得混入彩色/装饰文本。

## 2. REPL 命令

| 命令 | 作用 |
| --- | --- |
| `/help` | 命令帮助 |
| `/provider [provider:model]` | 查看或切换下一个 run 的 provider/model |
| `/preset [name]` | 查看或切换预设（single / supervisor / swarm） |
| `/tools [source]` | 列出工具及风险等级 |
| `/plugins` | 插件状态 |
| `/mcp` | MCP server 状态 |
| `/trace` | 当前 run 的 trace 路径与摘要 |
| `/history [n]` | 最近 n 条对话（默认 10） |
| `/new` | 新建会话 |
| `/sessions` | 会话列表 |
| `/session` | 当前会话信息 |
| `/config` | 有效配置（密钥脱敏） |
| `/quit`、`/exit` | 退出 |

**Ctrl+C**：

- 第一次：取消当前 run，回到 REPL；
- 第二次：退出进程；
- 审批提示中按 Ctrl+C：视为拒绝，不取消整个 run（除非连续两次）。

## 3. 审批交互

### 3.1 write

```text
⚠ write · code · write_file
目标: notes/summary.md
参数:
  path: notes/summary.md
  content: "# Summary\n..." (2.1 KB，审批展示可截断；完整参数传给工具)
批准执行？[y/N]
```

### 3.2 exec（两次确认）

```text
⚠ exec · code · run_shell
命令: echo hello
来源: code · 风险: exec
第一次确认：批准执行？[y/N]
```

第一次批准后：

```text
第二次确认：输入 run 以执行，输入其他内容取消：
```

**规则**：

- 必须展示工具名、来源、风险、目标路径/命令；不得用模型生成的摘要替代原始参数。
- write 的内容可截断，但路径必须完整；exec 的命令必须完整。
- `--yolo` 跳过提示；硬拒绝列表仍生效。
- 非交互且无脚本策略：write/exec 直接拒绝，并记录 `tool.approval.decided { decision: "deny", reason: "non-interactive" }`。
- 审批超时（`approvals.timeoutMs > 0`）：拒绝，reason `timeout`。
- 同一轮多个风险工具：按模型返回顺序串行提示；每个都有独立 `approvalId`。

## 4. 输出模式

| 模式 | 行为 |
| --- | --- |
| human（默认） | 流式 token、工具卡片、审批提示、最终摘要、彩色输出 |
| `--json` | stdout 输出 NDJSON 事件；无彩色/装饰；审批必须由 `--script` 或 `--approval-policy` 提供 |
| `--quiet` | 只输出最终答案；错误写 stderr |
| `--no-color` | 关闭 ANSI 颜色，保留结构 |

**工具卡片**（human）：

```text
→ tool write_file [code · write] 12 ms
← ok 1.2 KB
```

**run 摘要**：

```text
run_4c1d...  ok  4.2s  openai:gpt-4.1-mini
steps=3  tokens=1,842  approvals=2  subagents=1
trace: .agent-shell/traces/ses_.../run_....jsonl
```

## 5. 脚本化模式

用于离线验收、CI 和无 TTY 环境。

```json
{
  "version": 1,
  "provider": "openai:fake",
  "preset": "single",
  "turns": [
    { "input": "读取 notes/a.md", "expect": { "contains": "hello" } }
  ],
  "approvals": [
    { "tool": "write_file", "decision": "approve" },
    { "tool": "run_shell", "decision": "approve", "confirmation": "run" }
  ]
}
```

**规则**：

- `approvals` 按声明顺序消费；可用 `argsMatch` 做 JSON 子集匹配，`occurrence` 指定第几次。
- 未匹配到的 write/exec 默认拒绝，并使脚本失败。
- `expect.contains` 断言最终答案；`exitCode` 断言退出码。
- CLI 只负责“用户回合 + 审批决策”；模型输出由测试侧的 `ScriptedChatModel` 提供（见 04）。
- 脚本模式不得访问网络（除显式配置的本地 MCP server）；CI 中禁止真实 API。

## 6. 事件 schema v1

### 6.1 信封

```ts
type AgentEvent = {
  v: 1;
  id: string;              // evt_ + UUID v4（Node crypto.randomUUID）
  ts: string;              // ISO 8601，带毫秒
  sessionId: string;       // ses_...
  runId: string;           // run_...
  spanId: string;          // spn_...
  parentSpanId?: string;   // 子 span 必填
  type: AgentEventType;
  source: "runtime" | "graph" | "provider" | "tool" | "plugin" | "mcp" | "subagent" | "approval" | "cli";
  payload: Record<string, unknown>;
};
```

**关联规则**：

- 根 span 的 `spanId` 在 `run.started` 中生成，后续 run 级事件复用；
- 每次 graph node 执行、LLM 调用、工具调用、子 agent 运行各自生成子 span；
- LangChain 回调的 `runId` 映射到 `spanId`；映射关系写入 `log` 事件（debug）或内部映射表，不写入每条事件；
- `parentSpanId` 缺失表示根 span。

### 6.2 事件类型

| type | source | 关键 payload | 说明 |
| --- | --- | --- | --- |
| `run.started` | runtime | `inputPreview`、`provider`、`model`、`preset`、`resumedFrom?` | run 开始 |
| `run.finished` | runtime | `status`（ok/error/cancelled/denied）、`durationMs`、`usage`、`stepCount`、`subagentCount` | run 结束，必发；`denied` 仅用于无法继续的审批拒绝 |
| `run.error` | runtime | `error`（name/code/message） | 未恢复错误；stack 仅 debug |
| `graph.node.started` | graph | `node`、`step` | 可选粒度，默认开启 |
| `graph.node.finished` | graph | `node`、`durationMs` | |
| `llm.started` | provider | `provider`、`model`、`messageCount`、`toolCount`、`stream` | 不记录完整历史 |
| `llm.completed` | provider | `finishReason`、`usage`、`durationMs`、`firstTokenMs?`、`outputPreview`、`outputTruncated`、`outputSha256` | usage 可含 `estimated` |
| `llm.error` | provider | `provider`、`model`、`error` | |
| `tool.started` | tool | `name`、`source`、`risk`、`callId`、`argsPreview`、`argsTruncated` | 执行前 |
| `tool.approval.requested` | approval | `approvalId`、`name`、`source`、`risk`、`argsPreview`、`attempt` | attempt=1/2 |
| `tool.approval.decided` | approval | `approvalId`、`decision`、`actor`（user/policy/script）、`reason?` | |
| `tool.finished` | tool | `name`、`callId`、`durationMs`、`resultPreview`、`truncated`、`sha256`、`isError` | |
| `tool.error` | tool | `name`、`callId`、`error` | |
| `subagent.started` | subagent | `pattern`（spawn/supervisor/swarm）、`name`、`depth`、`taskPreview` | 子 span |
| `subagent.finished` | subagent | `pattern`、`name`、`status`、`durationMs`、`usage` | |
| `subagent.handoff` | subagent | `from`、`to`、`reason?` | supervisor/swarm |
| `plugin.loaded` | plugin | `name`、`version`、`apiVersion`、`tools` | 启动时 |
| `plugin.error` | plugin | `name`、`path`、`error` | 加载/执行 |
| `mcp.connected` | mcp | `server`、`transport`、`toolCount` | |
| `mcp.disconnected` | mcp | `server`、`reason?` | |
| `mcp.error` | mcp | `server`、`error` | 连接/调用 |
| `session.started` | runtime | `sessionId`、`threadId` | |
| `session.resumed` | runtime | `sessionId`、`threadId`、`checkpointId?` | |
| `budget.exceeded` | runtime | `kind`（steps/tokens/time/subagents）、`limit`、`used` | |
| `trace.redaction` | runtime | `fieldsRedacted` | 脱敏摘要 |
| `log` | runtime/cli | `level`、`message`、`fields?` | 诊断，默认 debug 关闭 |

### 6.3 payload 约定

- 所有 `*Preview` 字段是字符串或结构化摘要；默认上限 16KB，超限设 `truncated: true` 并附 `sha256`。
- `run.started.inputPreview` 上限 2KB；`llm.started` 只记录消息数量，不记录完整历史。
- `usage` 结构：`{ inputTokens, outputTokens, totalTokens, estimated?: boolean }`。
- `error` 结构：`{ name, code?, message }`；stack 仅在 `--verbose`/debug 下记录。
- 时间统一 ISO 8601 UTC；时长单位毫秒。
- 事件一经写入不可修改；schema 版本通过 `v` 区分。

## 7. Trace 文件布局

```text
.agent-shell/
  state.sqlite                 # LangGraph checkpointer + sessions 元数据
  traces/
    ses_<uuid>/
      run_<uuid>.jsonl         # 每行一个 AgentEvent
```

- 每个 run 一个文件；追加写，行分隔 JSON。
- 文件权限 0600；目录 0700。
- 进程崩溃时，最后一行可能不完整；读取端必须跳过无法解析的最后一行并告警。
- v1 不自动清理；用户可手动删除旧 trace。`trace list` 扫描目录，不依赖数据库。
- trace 与 checkpoint 分离：trace 是回放来源，checkpoint 是会话恢复来源。

## 8. Trace 查看器

### 8.1 `trace list`

```text
RUN ID              SESSION        STARTED           STATUS  PROVIDER:MODEL          DURATION  TOKENS  STEPS  APPROVALS  SUBAGENTS
run_4c1d...          ses_7a2b...     2026-11-03 12:34  ok      openai:gpt-4.1-mini     4.2s      1,842   3      2          1
```

`--json` 输出数组，字段与表格一致。

### 8.2 `trace show`

```text
run_4c1d...  ok  4.2s  openai:gpt-4.1-mini  tokens=1,842
├─ llm.completed  1.2s  620/180
├─ tool write_file  [write · approval=approve]  12ms  ok 1.2KB
├─ subagent spawn researcher  depth=1  2.8s
│  ├─ llm.completed  1.0s  300/90
│  └─ tool read_file  [read · auto]  3ms  ok 800B
├─ subagent.finished  researcher  ok
└─ run.finished  ok
```

- 按 `parentSpanId` 建树；同层按 `ts` 排序。
- 默认隐藏 `log` 事件；`--verbose` 显示。
- `--json` 输出原始事件对象数组；`--raw` 输出 JSONL 原文。
- `trace tail` 从文件尾部跟随新增事件，用于实时观察。

## 9. 脱敏与截断

**脱敏**：

- 键名匹配（大小写不敏感）：`authorization`、`api_key`、`apikey`、`token`、`secret`、`password`、`cookie`、`set-cookie`、`x-api-key`；
- 环境变量值：`*_KEY`、`*_TOKEN`、`*_SECRET`、`*_PASSWORD`、`*_CREDENTIAL*`，以及已加载 provider 的密钥值；
- 所有 HTTP headers 默认不记录；
- 配置导出（`/config`、`config show`）必须脱敏；
- 错误消息、堆栈、MCP 连接信息同样脱敏；
- 每次脱敏发一条 `trace.redaction`，只记录字段数量，不记录原值。

**截断**：

| 字段 | 上限 | 备注 |
| --- | --- | --- |
| `run.started.inputPreview` | 2 KB | 超出加省略号 |
| 工具参数（`argsPreview`） | 16 KB | write 的路径/exec 的命令必须完整 |
| 工具结果 | 16 KB | 超限 `truncated: true` + `sha256` |
| LLM 输出预览 | 16 KB | 完整内容在 checkpoint 消息中 |
| 错误消息 | 4 KB | 堆栈仅在 debug |

**默认不记录**：

- token delta（`trace.streamDeltas: false`）；
- 完整消息历史；
- HTTP headers、原始请求体、原始响应体；
- 插件源码、MCP server 环境变量。

## 10. 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 未预期的内部错误 |
| 2 | 配置错误（含密钥缺失、命名冲突、schema 非法） |
| 3 | Provider 错误（鉴权、限流、网络、协议） |
| 4 | 工具/插件/MCP 错误（无法恢复） |
| 5 | 审批拒绝导致 run 无法继续 |
| 6 | 预算超限 |
| 130 | 用户取消（Ctrl+C） |

**说明**：工具错误通常以 ToolMessage 回给模型，不直接退出；只有无法恢复时才用 4。审批拒绝同理，优先让模型继续；只有在脚本/非交互要求失败时用 5。

## 11. LangSmith（可选）

- 默认关闭；`trace.langsmith: "off" | "env"`。
- 开启方式：设置 `LANGSMITH_TRACING=true`、`LANGSMITH_API_KEY`、`LANGSMITH_PROJECT`、`LANGSMITH_ENDPOINT`（旧 `LANGCHAIN_*` 变量兼容）。
- LangSmith 只是投影；本地 JSONL 仍是唯一真相源。
- 开启后数据离开本机，文档必须提示；验收不依赖 LangSmith。
- 不在配置文件中写 API key；只从环境变量读取。
