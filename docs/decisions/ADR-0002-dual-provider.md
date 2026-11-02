# ADR-0002 · 双 Provider 通过 LangChain 集成层实现

> 状态：已接受  
> 日期：2026-11-03  
> 关联：[01-architecture.md](../01-architecture.md)

## 背景

首期必须同时支持 OpenAI 兼容接口（OpenAI / Azure / 自建网关 / 多数国产模型）和 Anthropic。需要统一的流式、tool calling、usage、超时与重试，同时避免把两家协议差异扩散到业务层。

## 决策

- 使用 `@langchain/openai` 的 `ChatOpenAI` 与 `@langchain/anthropic` 的 `ChatAnthropic` 作为传输层。
- 在 core 建立 `ProviderRegistry`：配置解析、模型选择（`provider:model`）、能力矩阵、超时/重试、usage 提取。
- 不自研 wire protocol，不直接调用 HTTP API。
- provider 按 run 生效；同一 thread 跨 provider 仅 best-effort，失败时提示 `/new`。
- 阶段 0 冻结 capability matrix；阶段 1 用本地 HTTP mock 做双协议契约测试。

## 后果

**正面**：

- 一个配置层覆盖两类接口；新增 OpenAI 兼容网关只需改 `baseURL`/`headers`。
- LangChain 统一 `BaseChatModel`，消息与工具调用形状一致。
- 重试、流式、usage 有现成实现，壳专注于编排与可观测。

**负面/风险**：

- 受 LangChain 抽象约束；provider 特有功能可能无法直接使用。
- 跨 provider 消息历史兼容性不保证；需要文档与错误提示。
- LangChain 升级可能带来行为变化；需锁版本与契约测试。

## 备选方案

- **直接使用官方 SDK**：控制力更强，但两套流式/工具协议、重试、usage 都要自写，首期成本过高。
- **只接一家**：与需求冲突。
- **自研统一协议**：重复造轮子，且无法覆盖两家快速变化的能力。

## 复审条件

- 某 provider 的关键能力在 LangChain 层不可用；
- 跨 provider 会话成为核心需求；
- LangChain 集成层出现长期未修复的阻塞问题。
