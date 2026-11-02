# Live smoke · 真实 Provider 手动验收

> 状态：手册  
> 关联：[00-requirements.md](./00-requirements.md) AC-2 · [04-testing-and-acceptance.md](./04-testing-and-acceptance.md) §3.5 · [02-roadmap.md](./02-roadmap.md) 阶段 7
>
> Live smoke **不进 CI**，不使用 `pnpm acceptance` 的离线剧本。它验证的是「真实 SDK + 真实服务」这一段，离线契约测试只能证明协议适配，不能证明服务行为。

## 1. 前置

```bash
export OPENAI_API_KEY=<你的 key>          # 阶段 0 起只从环境变量读取
export OPENAI_BASE_URL=<可选，兼容网关>    # 例：自建 OpenAI 兼容端点
export ANTHROPIC_API_KEY=<你的 key>
```

- 只使用最小模型与最短 prompt；不要跑长循环（成本可控）。
- 工作目录建议是 `examples/file-agent`，它自带代码工具、`word-count` 插件、echo MCP server 与三个 preset。
- 全程产生的 key 只会以「环境变量名」形式出现在配置里；任何 key 值都不允许出现在 trace、日志、错误消息或本手册的记录中。

## 2. 步骤

```bash
# 0) 诊断（不发计费请求）
agent-shell doctor

# 0b) 可选：最小探测，会真实调用一次模型
agent-shell doctor --probe

# 1) OpenAI 兼容：普通对话
agent-shell run "用一句话介绍你自己" --provider openai:gpt-4.1-mini

# 2) read 工具（应自动放行，无审批提示）
agent-shell run "读取 notes/a.md 并总结" --provider openai:gpt-4.1-mini

# 3) write 工具（一次确认）
agent-shell run "把 notes/a.md 的摘要写入 notes/summary.md" --provider openai:gpt-4.1-mini

# 4) exec 工具（两次确认，第二次必须输入 run）
agent-shell run "执行 echo hello 并告诉我输出" --provider openai:gpt-4.1-mini

# 5) spawn 子 agent（researcher 只读工具子集）
agent-shell run "派生 researcher 读取 notes/b.md 并回报结论" --provider openai:gpt-4.1-mini

# 6) 切换到 Anthropic：普通对话 + 一次工具调用
agent-shell run "读取 notes/a.md 并用一句话总结" --provider anthropic:claude-sonnet-4-6

# 7) 回放
agent-shell sessions list
agent-shell trace list
agent-shell trace show <run-id>
```

## 3. 通过标准

逐项确认，任何一项不满足即为失败（不要以 exit code 0 代替）：

| 项 | 期望 |
| --- | --- |
| Provider 路由 | 两次 `run` 分别命中 openai 与 anthropic；`llm.started.payload.provider` 可区分 |
| 流式 | 首 token 前无整段等待；`llm.completed.payload.firstTokenMs` 有值 |
| 工具调用 | `tool.started` 的 `source` 至少覆盖 `code`；插件/MCP 若使用则出现 `plugin__` / `mcp__` 前缀 |
| 审批 | write 一次 `attempt=1`；exec 两次 `attempt=1` 与 `attempt=2`，第二次输入非 `run` 必须拒绝 |
| 拒绝路径 | 任一次拒绝后模型收到 ToolMessage 并给出替代方案，run 不崩溃 |
| 子 agent | `subagent.started`/`subagent.finished` 成对，`depth=1`，子 span 有 `parentSpanId` |
| usage | `llm.completed.payload.usage.estimated` 为 false（真实 usage 存在时） |
| 秘密 | `grep -R "$OPENAI_API_KEY\|$ANTHROPIC_API_KEY" .agent-shell` 无命中；`/config` 输出只有变量名 |
| 取消 | 运行中 Ctrl+C：`run.finished.status = "cancelled"`，checkpoint 保留 |

## 4. 记录格式（不含 key）

```text
日期：YYYY-MM-DD
模型：openai:<model-id> / anthropic:<model-id>
run id：run_xxxxxxxx（每个步骤一行）
结果：pass / fail（fail 附失败项与 trace 路径）
耗时/花费提示：<可选>
```

把上面的记录追加到 `docs/phases/07-acceptance.md` 的「live smoke」小节。trace 文件本身留在 `.agent-shell/traces/`（已被 `.gitignore` 排除），不要提交。

## 5. 失败时怎么办

- 只有真实服务才复现的问题：**不要**改离线断言。在 `docs/phases/07-acceptance.md` 记录现象、模型 ID、run ID，并判断是 adapter 缺陷还是上游行为差异；破坏契约时写 ADR。
- 鉴权/限流：确认 `ProviderError` 的 kind 与退出码 3；这类失败不算实现缺陷。
- 若某 provider 不支持工具调用：能力矩阵应提前拒绝，而不是运行到一半失败。
