# agent-shell

本地优先、无业务绑定的 agent 运行时外壳。核心提供模型、工具、子 agent、审批、会话与可观测性；业务能力通过配置、代码工具、插件和 MCP 注入。

## 状态

**设计冻结，尚未开始实现。**  
下一步：阶段 0（契约与骨架），见 [docs/02-roadmap.md](./docs/02-roadmap.md)。

## 这是什么

- 一个可组合的 agent 内核：双 Provider、三工具源、三档审批、三种子 agent 形态、SQLite 会话、JSONL trace。
- 一个 CLI：REPL、单次执行、审批交互、trace 回放。
- 一个可扩展的壳：新增 Provider/工具/插件/MCP/子 agent 模式不修改核心循环。

## 这不是什么

- 不是业务应用：仓库不包含邮件、搜索、数据库等业务能力；文件助手只作为 `examples/` 参考场景。
- 不是 Web 平台：v1 没有 Web UI、HTTP API、多用户、鉴权。
- 不是插件沙箱：插件同进程加载，只信任本地代码；风险见 [ADR-0007](./docs/decisions/ADR-0007-trusted-plugins.md)。
- 不是长期记忆/RAG 系统：只做会话持久化。

## 文档

| 文档 | 内容 |
| --- | --- |
| [AGENT.md](./AGENT.md) | 开发规范、不变量、阶段纪律、安全/测试/文档/Git 规则 |
| [docs/00-requirements.md](./docs/00-requirements.md) | 目标、非目标、功能/非功能需求、验收标准 |
| [docs/01-architecture.md](./docs/01-architecture.md) | 组件、运行时流程、契约、安全模型、版本基线、风险 |
| [docs/02-roadmap.md](./docs/02-roadmap.md) | 8 个内部阶段、依赖、门禁、首期 DoD |
| [docs/03-cli-and-trace.md](./docs/03-cli-and-trace.md) | CLI 命令、审批交互、事件 schema v1、trace 规范 |
| [docs/04-testing-and-acceptance.md](./docs/04-testing-and-acceptance.md) | 测试分层、单一端到端剧本、CI 门禁、live smoke |
| [docs/decisions/](./docs/decisions/) | 8 条 ADR 决策记录 |

## 关键决策

- 运行时：LangGraph 1.x / LangChain 1.x，主循环自建 StateGraph，子 agent 复用官方 prebuilt 与 supervisor/swarm。
- Provider：OpenAI 兼容 + Anthropic，统一走 LangChain 集成层。
- 工具：代码注册 + 目录插件 + MCP，统一注册表、命名与风险。
- 审批：read 自动、write 一次、exec 两次；工作区路径守卫兜底。
- 子 agent：spawn、supervisor、swarm 三种形态内置。
- 可观测：本地 JSONL 事件流为唯一真相源，LangSmith 可选。
- 插件：同进程、显式启用、信任本地代码；v1 不沙箱。
- 交付：首期一次交付全功能，内部拆 8 个阶段，单一离线剧本验收。

完整理由见 [docs/decisions/](./docs/decisions/)。

## 计划中的用法

> 以下命令尚未实现，仅表示目标形态；不要在当前仓库直接运行。

```bash
# 诊断
agent-shell doctor

# 单次执行
agent-shell run "读取 notes/a.md 并总结" --preset single

# 交互
agent-shell chat

# 回放
agent-shell trace show <run-id>
```

配置组合根（计划）：

```ts
// agent-shell.config.ts
import { defineConfig, env } from "@agent-shell/core";

export default defineConfig({
  providers: {
    openai: { kind: "openai", apiKey: env("OPENAI_API_KEY") },
    anthropic: { kind: "anthropic", apiKey: env("ANTHROPIC_API_KEY") },
  },
  defaults: { provider: "openai:gpt-4.1-mini", preset: "single" },
  // agents 定义（default / lead / researcher / writer）省略，见 docs/01-architecture.md §5.6
  presets: {
    single: { kind: "single", agent: "default" },
    team: { kind: "supervisor", supervisor: "lead", agents: ["researcher", "writer"] },
    swarm: { kind: "swarm", agents: ["researcher", "writer"], defaultActiveAgent: "researcher" },
  },
  // ...
});
```

## 计划目录

```text
packages/core     运行时内核（无业务）
packages/cli      CLI
examples/         无业务参考场景（file-agent）、示例插件、示例 MCP server
docs/             设计文档与 ADR
```

## 贡献

先读 [AGENT.md](./AGENT.md)，再按阶段推进。当前处于设计冻结期，不接受跳过阶段 0 的实现提交。
