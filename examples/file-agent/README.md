# examples/file-agent · 唯一参考场景

`packages/core` 零业务（AGENT.md §2），业务工具只存在于这里。本目录是 docs/00-requirements.md
FR-13 与 docs/04-testing-and-acceptance.md §4.1 的参考实现：代码工具 + 插件 + 本地 MCP +
三种子 agent 形态，全部离线、无真实密钥。

## 目录

| 路径 | 作用 |
| --- | --- |
| `agent-shell.config.ts` | 组合根：providers / tools / plugins / mcp / agents / presets（docs/01 §5.9），`satisfies RawConfig` 编译期校验 |
| `tools/read-file.ts` `tools/write-file.ts` `tools/run-shell.ts` | 三个代码工具，`defineTool()` 注册，风险 read / write / exec |
| `plugins/word-count/` | 插件工具源：manifest + `definePlugin()` 入口 |
| `mcp-echo-server/server.mjs` | stdio MCP server：`echo`（readOnlyHint）、`write_note`（默认 exec） |
| `model.script.json` | `ScriptedChatModel` 的模型脚本，驱动 Acts 1–7（docs/04 §2.1） |
| `scenario.acceptance.json` | CLI 脚本模式文件：用户回合 + 审批决策（docs/03 §5） |
| `workspace/notes/` | 独立运行时的默认 workspace（`notes/a.md` = `hello world`，`notes/b.md` = `agent shell`） |
| `test/scenario.test.ts` | 不依赖 CLI 的场景完整性测试：配置、工具、插件、脚本、命名空间、MCP server |

## 独立运行

CLI 尚未落地（阶段 0 只冻结契约），因此命令是**写给验收 runner 的**，见
docs/04 §4.4：runner 建临时 workspace、写这两个 script 文件、依次执行 Acts、解析 trace。
命令形状如下（`--config` 指向本目录，`--workspace` 覆盖 `workspaceRoot`）：

```bash
# Act 1：代码工具读取 + 自动放行
node packages/cli/bin/agent-shell.js run "读取 notes/a.md 并总结" \
  --config examples/file-agent/agent-shell.config.ts \
  --provider openai:fake --preset single --script examples/file-agent/scenario.acceptance.json

# Act 8 / 9：子 agent 形态
node packages/cli/bin/agent-shell.js run "总结两个文件" \
  --config examples/file-agent/agent-shell.config.ts --preset team
node packages/cli/bin/agent-shell.js run "先研究再写摘要" \
  --config examples/file-agent/agent-shell.config.ts --preset swarm
```

`agent-shell` 的 `doctor` / `tools list` / `plugins list` / `mcp list` 都直接消费本目录配置，
所以任何“这个场景能跑起来”的断言都必须由 runner 或 `pnpm acceptance` 给出证据，
本页的命令目前**不可执行**。

本目录自带离线测试（不需要 CLI，也不需要 core 构建产物）：

```bash
# 根 vitest.config.ts 的 include 只覆盖 packages/* 与 tooling/*，所以本场景用自己的配置
npx vitest run --config examples/file-agent/vitest.config.ts
node_modules/.bin/tsc --noEmit -p examples/file-agent/tsconfig.json
node examples/file-agent/mcp-echo-server/server.mjs --help
```

## 能力演示

- **code 工具**：`read_file`（read，自动放行）、`write_file`（write，1 次确认）、
  `run_shell`（exec，2 次确认，第二次输入 `run`；只允许 `echo`，用 `spawn` + 参数数组执行）。
- **plugin**：`word-count` → 最终工具名 `plugin__word_count__word_count`。
- **mcp**：`echo` server → 最终工具名 `mcp__echo__echo`、`mcp__echo__write_note`。
- **subagents**：`spawn`（`researcher` 只读子集）、`team`（supervisor：`lead` + researcher/writer）、
  `swarm`（researcher ↔ writer）。
- **双 provider**：`openai:fake` 与 `anthropic:fake` 都是 `kind: "scripted"`，同一个模型脚本；
  密钥只通过 `env("NAME")` 引用，本场景不需要任何真实 key。

## 信任边界（如实描述）

- 配置文件、代码工具、插件是**本地可信代码**；插件与 shell **同进程、拥有完整 Node 权限，
  不是沙箱**，可以绕过审批，只加载 `plugins.dirs` 显式声明的目录（ADR-0007）。
- MCP server 是**外部不可信**进程：默认风险 `exec`，只有 `readOnlyHint` 才降级；输出当数据、
  不当指令，永不自动批准。
- 模型输出不可信：所有工具参数都先用 zod 校验，路径一律经过 workspace 守卫
  （`..`、越界绝对路径、symlink 逃逸都会拒绝），审批是最后一道防线。
- `mcp-echo-server/server.mjs` 只往 stdout 写协议帧，诊断全部走 stderr；
  `--crash-on-call` 与 `--slow <ms>` 是给崩溃/超时用例用的。

## 已知限制（runner 需要采用的约定）

- **测试入口**：根 `vitest.config.ts` 的 `include` 只有 `packages/*/test/**` 与
  `tooling/*/test/**`，不覆盖 examples，所以本场景另带 `vitest.config.ts`：
  `npx vitest run --config examples/file-agent/vitest.config.ts`（`npx vitest run
  examples/file-agent` 目前会报 “No test files found”，除非根配置加上 examples glob）。
- **workspace**：`workspaceRoot: "./workspace"` 只在进程 cwd 为本目录时生效——
  `resolveRuntimePaths()` 用 `path.resolve()` 按进程 cwd 解析配置里的相对路径（docs/01 §5.9）。
  runner 应显式传 `--workspace <tmp>` 并自备 `notes/a.md`（`hello world`）与
  `notes/b.md`（`agent shell`）；本目录的 `workspace/notes/` 只是独立运行用的同款 fixture。
- **相对路径基准**：`plugins.dirs`、`mcp.servers.echo.command/args` 由各自的加载器解析；
  provider 的 `script: "./model.script.json"` 由 provider 注册表（阶段 2+）解析，本目录只提供
  文件，不假定其相对基准必须是配置文件目录。`command: "node"` 依赖 PATH。
- **最终工具名**（模型脚本必须写这些名字）：`read_file` / `write_file` / `run_shell`、
  `plugin__word_count__word_count`、`mcp__echo__echo`、`mcp__echo__write_note`、
  `runtime__spawn_subagent`。
- **provider 引用**：配置里的 key 是 `openai` / `anthropic`，CLI 用 `provider:model` 引用
  `openai:fake` / `anthropic:fake`（key 不能含 `:`）。两个 provider 都 `kind: "scripted"`，
  共用 `model.script.json`。
- **agent 工具子集**：`agents.*.tools` 只能写代码工具名——`validateConfig()` 拒绝 namespaced
  名称；plugin/MCP 工具靠 `agents.default.tools: []`（= 整个 registry）在运行时可用，
  `researcher` 是只读子集，`writer` 是读写子集。
- **模型脚本按 agent 分段**：`model.script.json` 的 step 带 `agent` 字段（researcher 有自己的
  step），`ScriptedChatModel` 一次调用消费一个 step；Acts 8/9（team/swarm）若需要不同的 worker
  台词，runner 可用 `providers.*.scripts` 覆盖或另写脚本文件。
- **脚本文件是列表**：`scenario.acceptance.json` 顶层是**数组**，每个元素都是一个符合 docs/03 §5
  形状的脚本对象（provider/preset + turns + approvals），因为单个对象无法表达 Act 7–9 的
  provider/preset 切换。CLI 需要接受“数组 = 依次执行的脚本组”。
- **Act 11**（`trace show`）不是用户回合，因此不在脚本文件里，由 runner 直接断言 trace。
- **Act 10**：`checkpointer: "memory"` 保证 Acts 确定性，但跨进程 `sessions resume` 需要 runner
  把 `checkpointer` 换成 `sqlite`（或用同进程多轮 turn 演示恢复）。
- **插件加载前提**：`plugins/word-count/entry.mjs` 按规范 import `@agent-shell/core/plugin`，
  该入口只在 `pnpm --filter @agent-shell/core build` 之后存在；本目录的 TS 文件为了避免依赖
  构建产物，用相对路径直接引用 core 源码（`packages/core/src/...`）。
- **MCP server 位置**：docs/04 §2.3 写的是 `examples/mcp-echo-server`，本场景按“单目录自包含”
  放在 `examples/file-agent/mcp-echo-server/server.mjs`；以配置里的路径为准。
