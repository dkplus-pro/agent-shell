# 03 · 插件系统

> 状态：已完成  
> 开始日期：2026-11-03  
> 完成日期：2026-11-03  
> 关联 ADR：ADR-0003、ADR-0007

## 1. 目标

外部工具可以通过目录插件接入，但不破坏启动稳定性：manifest 校验、同进程 jiti 加载、API 版本门禁、逐插件失败隔离、`plugins list` 与示例插件 word-count。门禁：合法/非法/重名/崩溃四类测试通过（`docs/02-roadmap.md` §3 阶段 3）。

## 2. 范围

- 做：`packages/core/src/plugins/`（api/loader/index）、`@agent-shell/core/plugin` 子路径导出（`packages/core/package.json` exports）、插件工具命名接入 `tools/registry.ts::registerPlugin`、`agent-shell plugins list`（`packages/cli/src/commands/inspect.ts`）、示例插件 `examples/file-agent/plugins/word-count/`、失败隔离测试与 fixtures（`packages/core/test/fixtures/plugins/`）。
- 不做：沙箱/进程隔离（ADR-0007 明确同进程全权限）、插件自动发现（只扫描 `plugins.dirs` 显式声明目录）、插件独立文档站。
- 对上游：消费阶段 2 的 ToolRegistry/审批管线——插件工具与 code 工具走同一个 executor；对下游：阶段 5 的 spawn/supervisor 可把插件工具授予子 agent。

## 3. 设计要点

- **作者面 API 冻结在子路径**：插件只能 import `@agent-shell/core/plugin`（`packages/core/src/plugins/api.ts`：`PLUGIN_API_VERSION = "1.0.0"`、`pluginManifestSchema`、`definePlugin`/`definePluginTool`、`PluginSetupContext`）。这是 AGENT.md §2 依赖纪律的物理形态。
- **manifest schema**：`name`/`version`/`apiVersion`/`entry`/`description`；entry 必须是目录内相对路径（`traversal-entry` fixture 验证越界 entry 被拒）。
- **加载器**（`plugins/loader.ts`）：jiti 2 同进程加载 TS/JS，`interopDefault: true` 兼容 CJS 默认导出，`moduleCache: false` 避免重扫命中陈旧模块缓存（roadmap 阶段 3 风险预案）。逐插件 try/catch：manifest 非法、apiVersion 不匹配、entry 缺失、factory 抛错、返回非 Plugin 形状各归入 `report.failed`，加载器**从不因单个插件抛出**；`plugin.loaded`/`plugin.error` 事件 payload 与 event schema v1 逐键对齐。
- **命名与风险**：注册时命名空间化为 `plugin__<plugin>__<tool>`（`tools/naming.ts::pluginToolName`）；缺 `risk` 直接 `ConfigError`（`missing-risk` fixture）；同 registry 内重名 `NameConflictError`（`duplicate-tools` fixture）。
- **审批不豁免**：插件工具携带自身 risk 进入阶段 2 的审批管线，write/exec 照常 interrupt。
- **信任模型如实描述**：loader 头注释与 `docs/01` §5.4、word-count README 都明说「隔离的是故障，不是权限；无沙箱；路径守卫不自动约束插件」，遵守 ADR-0007。

## 4. 任务清单

- [x] `plugins/api.ts`：manifest schema v1 + `PLUGIN_API_VERSION` + define* 帮助函数
- [x] `plugins/loader.ts`：显式目录扫描、apiVersion 校验、失败隔离、事件上报
- [x] `registerPlugin` 接入 ToolRegistry（命名空间、风险必填、重名拒绝）
- [x] `agent-shell plugins list`（human + `--json`）
- [x] 示例插件 `examples/file-agent/plugins/word-count/`（`plugin.json` + `entry.mjs` + 纯函数 `count-words.mjs` + README 说明信任边界）
- [x] fixtures：`packages/core/test/fixtures/plugins/{invalid-manifest,api-version-mismatch,duplicate-tools,missing-risk,throwing-entry,traversal-entry,word-count}`
- [x] `packages/core/test/unit/plugins-loader.test.ts`（17 例）
- [x] 空/禁用目录时 shell 正常启动（`enabled: false` 或 `dirs: []` 直接返回空报告）

## 5. 验收证据

```text
$ npx vitest run packages/core/test/unit/plugins-loader.test.ts
17 通过：合法加载、非法 manifest、apiVersion 不匹配、entry 缺失/越界、
        重名冲突、factory 抛错隔离、禁用目录空扫描、plugin.loaded/plugin.error 事件形状
```

- 关键输出摘要：合法插件可加载、列出、被模型调用（Act 2 中 `plugin__word_count__word_count` 被调用，见 `tooling/acceptance/src/index.ts`）；单插件崩溃不阻塞 shell 启动；插件 write/exec 工具仍走审批。
- trace run ID：acceptance 临时 workspace 产生，不落库。
- 已知限制：apiVersion 目前为精确主版本匹配；未提供版本迁移工具（v1 无历史版本，暂不需要）。

## 6. 偏差与决策

- roadmap 交付物「插件作者文档」未做成独立文档：API/manifest/风险/信任模型的内容分布在 `plugins/api.ts` 头注释、`examples/file-agent/plugins/word-count/README.md`、ADR-0007 与 `docs/01-architecture.md` §5.4，作者面即 `@agent-shell/core/plugin` 的 `.d.ts`。若后续插件增多，应补独立作者指南（属文档增强，不改契约）。
- jiti v2 将 interop 标志更名为 `interopDefault`，与 roadmap 编写时预期的 v1 API 不同；已在 loader 注释记录，无需 ADR。

## 7. 遗留问题

| 问题 | 影响 | 处理阶段 | 负责人 |
| --- | --- | --- | --- |
| 同进程插件拥有完整 Node 权限、可绕过审批 | 只能加载用户显式启用的可信目录 | 已接受（ADR-0007），README/docs 如实声明 | — |
| 插件加载依赖 core 已构建（`pnpm --filter @agent-shell/core build`） | 作者需先 build 才能 import 子路径 | 文档化于 word-count README | — |
| 无独立插件作者文档 | 新人需拼合多处材料 | 后续增强 | docs |

## 8. 关联

- 需求：FR-11；门禁：`docs/02-roadmap.md` §3 阶段 3
- 架构：`docs/01-architecture.md` §5.4/§6、`docs/03-cli-and-trace.md` §2（plugins 命令）
- Commit / Tag：见仓库 `main`
