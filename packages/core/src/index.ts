/**
 * `@agent-shell/core` public surface. Anything the CLI or an example scenario
 * needs must come from here; adapters keep upstream SDK types out of callers.
 */

export * from './errors/index.js';
export * from './ids.js';
export * from './limits.js';

export {
  EVENT_SCHEMA_VERSION,
  EVENT_SOURCES,
  EVENT_TYPES,
  RUN_STATUSES,
  TOOL_RISKS,
  TOKEN_USAGE_SCHEMA,
  agentEventSchema,
  makeEvent,
  parseEventLine,
  validateEvent,
  type AgentEvent,
  type AgentEventSource,
  type AgentEventType,
  type NewEvent,
  type Risk,
  type RunStatus,
  type TokenUsage,
} from './events/schema.js';

export { EventBus, InMemorySink, type EventSink, type EventBusOptions } from './events/bus.js';
export { JsonlFileSink, ConsoleSink } from './events/sinks.js';
export { truncateText, truncateValue, sha256Hex, type TruncateResult } from './events/truncate.js';
export {
  REDACTED,
  collectEnvSecretValues,
  isSensitiveKey,
  redactEvent,
  redactValue,
  type RedactionOptions,
} from './events/redaction.js';
export {
  buildSpanTree,
  listRuns,
  readTraceFile,
  renderSpanTree,
  summarizeRun,
  tailTrace,
  type ReadTrace,
} from './events/reader.js';

export {
  SECRET_TAG,
  env,
  isSecretLike,
  requireSecret,
  revealSecret,
  type EnvSecretRef,
} from './config/secret.js';
export {
  DEFAULT_AGENT_PROMPT,
  agentDefinitionSchema,
  approvalConfigSchema,
  defineConfig,
  mcpServerConfigSchema,
  modelScriptSchema,
  presetDefinitionSchema,
  providerConfigSchema,
  rawConfigSchema,
  traceConfigSchema,
  validateConfig,
  type AgentDefinition,
  type ApprovalConfig,
  type McpServerConfig,
  type ModelScript,
  type PresetDefinition,
  type ProviderCapabilities,
  type ProviderConfig,
  type ProviderKind,
  type RawConfig,
  type ResolvedConfig,
  type TraceConfig,
} from './config/schema.js';
export {
  CONFIG_FILE_NAMES,
  discoverConfigPath,
  finalizeConfig,
  hasConfigFile,
  loadConfig,
  resolveRuntimePaths,
  type DiscoverOptions,
  type LoadedConfig,
  type RuntimePathOptions,
  type RuntimePaths,
} from './config/loader.js';
export {
  runDoctor,
  type DoctorCheck,
  type DoctorInput,
  type DoctorReport,
  type DoctorStatus,
} from './config/doctor.js';

export {
  defineTool,
  toolOutputToText,
  DEFAULT_TOOL_TIMEOUT_MS,
  TOOL_SOURCES,
  type ToolContext,
  type ToolDefinition,
  type ToolJson,
  type ToolLogger,
  type ToolOutput,
  type ToolSourceKind,
} from './tools/types.js';
export {
  TOOL_NAME_PATTERN,
  assertToolName,
  isReservedNamespace,
  mcpToolName,
  normalizeNameSegment,
  pluginToolName,
  runtimeToolName,
  splitToolName,
  type QualifiedOrigin,
} from './tools/naming.js';
export { ToolRegistry, type RegisteredTool } from './tools/registry.js';
export {
  ToolExecutor,
  type ApprovalInterruptAdapter,
  type ToolCall,
  type ToolExecutionResult,
} from './tools/executor.js';
export {
  guardToolPath,
  isInsideRoot,
  resolveWorkspacePath,
  type GuardOptions,
} from './tools/path-guard.js';
export { toLangChainTools, toolJsonSchemas } from './tools/langchain.js';

export {
  PLUGIN_API_VERSION,
  definePlugin,
  pluginManifestSchema,
  type Plugin,
  type PluginFactory,
  type PluginManifest,
  type PluginSetupContext,
} from './plugins/api.js';
export {
  loadPlugins,
  type PluginLoadFailure,
  type PluginLoadReport,
  type PluginLoadResult,
} from './plugins/loader.js';

export { MCPAdapter, type McpServerHandle, type McpToolDescriptor } from './mcp/adapter.js';

export {
  capabilitiesFor,
  formatModelRef,
  parseModelRef,
  DEFAULT_CAPABILITIES,
  type ChatModelHandle,
  type InvokeOptions,
  type ModelRef,
  type ProviderRegistry,
  type ResolvedProvider,
  type TokenUsageSummary,
} from './providers/types.js';
export { createProviderRegistry } from './providers/registry.js';

export { MemorySaver } from '@langchain/langgraph';
export { openCheckpointer, type OpenCheckpointerOptions } from './storage/checkpointer.js';
export { SessionStore } from './storage/sessions.js';
export type { SessionRecord } from './runtime/types.js';

export {
  SingleAgentState,
  buildSingleAgentGraph,
  messageText,
  messageToolCalls,
  prePassApprovals,
  type SingleGraphDeps,
} from './graph/single.js';
export { buildReactAgent, type LeafAgentSpec } from './agents/react.js';
export { buildSupervisorGraph, type SupervisorGraphOptions } from './agents/supervisor.js';
export { buildSwarmGraph, type SwarmGraphOptions } from './agents/swarm.js';
export { createSpawnToolDefinition, type SpawnDeps } from './agents/spawn.js';
export { classifyHandoffToolName } from './agents/handoff.js';

export {
  RunManager,
  traceFilePath,
  readInterrupts,
  type ActiveRun,
  type RunManagerDeps,
} from './runtime/run-manager.js';
export type { RunOptions, RunSummary, SpanNode, RunListEntry } from './runtime/types.js';

export {
  matchesAllowlist,
  evaluateApproval,
  findHardDeny,
  approvalPrompt,
  HARD_DENY_PATTERNS,
  HARD_DENY_WORDS,
  type ApprovalActor,
  type ApprovalDecision,
  type ApprovalHandler,
  type ApprovalOutcome,
  type ApprovalPolicyContext,
  type ApprovalRequest,
  type AllowlistRule,
} from './approvals/policy.js';

export { SHELL_VERSION } from './version.js';
