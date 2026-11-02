import { z } from 'zod';
import { TOOL_RISKS } from '../events/schema.js';
import { limitsSchema, partialLimitsSchema, type Limits } from '../limits.js';
import { TOOL_NAME_PATTERN } from '../tools/naming.js';
import type { ToolDefinition } from '../tools/types.js';
import { secretRefSchema } from './secret.js';

const NAME = TOOL_NAME_PATTERN.source;
const toolNameSchema = z.string().regex(TOOL_NAME_PATTERN, `must match ${NAME}`);
const keySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/i);

export const PROVIDER_KINDS = ['openai', 'anthropic', 'scripted'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const providerCapabilitiesSchema = z
  .object({
    streaming: z.boolean().default(true),
    toolCalling: z.boolean().default(true),
    vision: z.boolean().default(false),
    contextWindow: z.number().int().positive().default(128_000),
  })
  .strict();
export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;

/**
 * `apiKey` is a lazy env reference; `headers` intentionally accepts variable
 * names only, never literal values, so a config export stays secret-free.
 */
const baseProvider = {
  models: z.array(z.string().min(1)).default([]),
  timeoutMs: z.number().int().positive().default(120_000),
  maxRetries: z.number().int().nonnegative().default(2),
  capabilities: providerCapabilitiesSchema.partial().optional(),
};

export const openaiProviderSchema = z
  .object({
    kind: z.literal('openai'),
    apiKey: secretRefSchema,
    baseURL: z.string().url().optional(),
    headers: z.record(z.string(), secretRefSchema).default({}),
    ...baseProvider,
  })
  .strict();

export const anthropicProviderSchema = z
  .object({
    kind: z.literal('anthropic'),
    apiKey: secretRefSchema,
    baseURL: z.string().url().optional(),
    headers: z.record(z.string(), secretRefSchema).default({}),
    ...baseProvider,
  })
  .strict();

export const modelScriptStepSchema = z
  .object({
    content: z.string().optional(),
    toolCalls: z
      .array(
        z
          .object({
            name: toolNameSchema,
            args: z.record(z.string(), z.unknown()).default({}),
            id: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    streamChunks: z.array(z.string()).optional(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().optional(),
        outputTokens: z.number().int().nonnegative().optional(),
        totalTokens: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    agent: z.string().optional(),
    error: z
      .object({ name: z.string(), message: z.string(), code: z.string().optional() })
      .strict()
      .optional(),
  })
  .strict();

export const modelScriptSchema = z
  .object({ version: z.literal(1), steps: z.array(modelScriptStepSchema).min(1) })
  .strict();
export type ModelScript = z.infer<typeof modelScriptSchema>;

export const scriptedProviderSchema = z
  .object({
    kind: z.literal('scripted'),
    script: z.union([modelScriptSchema, z.string()]).optional(),
    scripts: z.record(z.string(), z.union([modelScriptSchema, z.string()])).default({}),
    ...baseProvider,
    apiKey: secretRefSchema.optional(),
  })
  .strict();

export const providerConfigSchema = z.discriminatedUnion('kind', [
  openaiProviderSchema,
  anthropicProviderSchema,
  scriptedProviderSchema,
]);
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

export const mcpServerConfigSchema = z.discriminatedUnion('transport', [
  z
    .object({
      transport: z.literal('stdio'),
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
      cwd: z.string().optional(),
      /** Environment variable names forwarded to the server; values stay in the environment. */
      envVars: z.array(z.string()).default([]),
      enabled: z.boolean().default(true),
      timeoutMs: z.number().int().positive().default(30_000),
      riskOverrides: z.record(z.string(), z.enum(TOOL_RISKS)).default({}),
    })
    .strict(),
  z
    .object({
      transport: z.literal('http'),
      url: z.string().url(),
      headers: z.record(z.string(), secretRefSchema).default({}),
      enabled: z.boolean().default(true),
      timeoutMs: z.number().int().positive().default(30_000),
      riskOverrides: z.record(z.string(), z.enum(TOOL_RISKS)).default({}),
    })
    .strict(),
]);
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

export const agentDefinitionSchema = z
  .object({
    name: z.string().regex(TOOL_NAME_PATTERN),
    prompt: z.string().min(1),
    tools: z.array(toolNameSchema).default([]),
    provider: keySchema.optional(),
    model: z.string().min(1).optional(),
    limits: partialLimitsSchema.optional(),
  })
  .strict();
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

export const presetDefinitionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('single'), agent: z.string() }).strict(),
  z
    .object({
      kind: z.literal('supervisor'),
      supervisor: z.string(),
      agents: z.array(z.string()).min(1),
      outputMode: z.enum(['full_history', 'last_message']).default('full_history'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('swarm'),
      agents: z.array(z.string()).min(2),
      defaultActiveAgent: z.string(),
    })
    .strict(),
]);
export type PresetDefinition = z.infer<typeof presetDefinitionSchema>;

export const allowlistRuleSchema = z
  .object({
    tool: toolNameSchema,
    argsMatch: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const approvalConfigSchema = z
  .object({
    /** 0 means wait forever; any positive value denies on timeout. */
    timeoutMs: z.number().int().nonnegative().default(0),
    allowlist: z.array(allowlistRuleSchema).default([]),
    extraHardDeny: z.array(z.string()).default([]),
    nonInteractive: z.enum(['deny', 'read-only']).default('deny'),
  })
  .strict();
export type ApprovalConfig = z.infer<typeof approvalConfigSchema>;

export const traceConfigSchema = z
  .object({
    dataDir: z.string().min(1).default('.agent-shell'),
    streamDeltas: z.boolean().default(false),
    maxFieldBytes: z.number().int().positive().max(1_048_576).default(16_384),
    langsmith: z.enum(['off', 'env']).default('off'),
    redactEnvPrefixes: z
      .array(z.string())
      .default(['*_KEY', '*_TOKEN', '*_SECRET', '*_PASSWORD', '*_CREDENTIAL*']),
  })
  .strict();
export type TraceConfig = z.infer<typeof traceConfigSchema>;

export const toolDefinitionSchema: z.ZodType<ToolDefinition<never, never>> = z.custom<
  ToolDefinition<never, never>
>((value) => {
  if (typeof value !== 'object' || value === null) return false;
  const tool = value as Partial<ToolDefinition<never, never>> & { schema?: unknown };
  return (
    typeof tool.name === 'string' &&
    TOOL_NAME_PATTERN.test(tool.name) &&
    typeof tool.description === 'string' &&
    (tool.risk === 'read' || tool.risk === 'write' || tool.risk === 'exec') &&
    typeof tool.execute === 'function' &&
    typeof tool.schema === 'object' &&
    tool.schema !== null &&
    typeof (tool.schema as { safeParse?: unknown }).safeParse === 'function'
  );
}, `tools.code entries must be ToolDefinition objects created with defineTool(): name matching ${NAME}, description, risk in read|write|exec, zod schema, execute()`);

export const rawConfigSchema = z
  .object({
    providers: z.record(keySchema, providerConfigSchema).default({}),
    defaults: z
      .object({
        provider: z
          .string()
          .regex(/^[a-z0-9_-]+(:[A-Za-z0-9._[\]-]+)?$/i)
          .optional(),
        preset: z.string().default('single'),
        agent: z.string().default('default'),
      })
      .strict()
      .default({ preset: 'single', agent: 'default' }),
    workspaceRoot: z.string().min(1).optional(),
    tools: z
      .object({ code: z.array(toolDefinitionSchema).default([]) })
      .strict()
      .default({ code: [] }),
    plugins: z
      .object({
        enabled: z.boolean().default(true),
        dirs: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .default({ enabled: true, dirs: [] }),
    mcp: z
      .object({
        servers: z.record(keySchema, mcpServerConfigSchema).default({}),
        configFile: z.string().optional(),
      })
      .strict()
      .default({ servers: {} }),
    agents: z.record(keySchema, agentDefinitionSchema).default({}),
    presets: z.record(keySchema, presetDefinitionSchema).default({}),
    approvals: approvalConfigSchema.prefault({}),
    limits: limitsSchema.prefault({}),
    trace: traceConfigSchema.prefault({}),
    checkpointer: z.enum(['sqlite', 'memory']).default('sqlite'),
  })
  .strict();

export type RawConfig = z.input<typeof rawConfigSchema>;
export type ResolvedConfig = z.output<typeof rawConfigSchema>;

export const DEFAULT_AGENT_PROMPT =
  'You are agent-shell, a local agent runtime. Use tools when they help; keep answers short.';

/**
 * Cross-reference validation runs after zod defaults so presets, providers and
 * agent names can be checked against each other.
 */
export function validateConfig(config: ResolvedConfig): ResolvedConfig {
  const fail = (message: string, path: string[]): never => {
    throw new z.ZodError([
      { code: 'custom', message, path, input: undefined } as unknown as z.ZodIssue,
    ]);
  };

  const providerIds = Object.keys(config.providers);
  if (providerIds.length === 0) {
    fail('No providers configured. Add at least one entry to `providers`.', ['providers']);
  }

  const defaultProvider = config.defaults.provider;
  if (defaultProvider) {
    const providerId = defaultProvider.split(':')[0] ?? defaultProvider;
    if (!(providerId in config.providers)) {
      fail(`defaults.provider "${defaultProvider}" refers to unknown provider "${providerId}".`, [
        'defaults',
        'provider',
      ]);
    }
  }

  if (!(config.defaults.preset in config.presets) && config.defaults.preset !== 'single') {
    fail(`defaults.preset "${config.defaults.preset}" is not defined in presets.`, [
      'defaults',
      'preset',
    ]);
  }

  const agentNames = new Set(Object.keys(config.agents));
  const knownToolNames = new Set<string>([
    ...config.tools.code.map((tool) => tool.name),
    'runtime__spawn_subagent',
  ]);

  for (const [id, agent] of Object.entries(config.agents)) {
    if (agent.name !== id) {
      fail(`agents.${id}.name ("${agent.name}") must equal its key.`, ['agents', id, 'name']);
    }
    if (agent.provider && !(agent.provider in config.providers)) {
      fail(`agents.${id}.provider refers to unknown provider "${agent.provider}".`, [
        'agents',
        id,
        'provider',
      ]);
    }
    for (const tool of agent.tools) {
      if (knownToolNames.has(tool)) continue;
      // Plugin and MCP tools only exist once the loader/adapter ran, so their
      // namespaced names are validated by shape here and for existence at startup.
      if (tool.startsWith('plugin__') || tool.startsWith('mcp__')) continue;
      fail(
        `agents.${id}.tools references "${tool}", which is not a code tool and is not namespaced as plugin__<plugin>__<tool> or mcp__<server>__<tool>.`,
        ['agents', id, 'tools', tool],
      );
    }
  }

  const requireAgent = (name: string, path: string[]): void => {
    if (!agentNames.has(name)) fail(`Unknown agent "${name}" referenced by a preset.`, path);
  };

  for (const [id, preset] of Object.entries(config.presets)) {
    if (preset.kind === 'single') requireAgent(preset.agent, ['presets', id, 'agent']);
    if (preset.kind === 'supervisor') {
      requireAgent(preset.supervisor, ['presets', id, 'supervisor']);
      preset.agents.forEach((worker, index) =>
        requireAgent(worker, ['presets', id, 'agents', String(index)]),
      );
    }
    if (preset.kind === 'swarm') {
      preset.agents.forEach((worker, index) =>
        requireAgent(worker, ['presets', id, 'agents', String(index)]),
      );
      requireAgent(preset.defaultActiveAgent, ['presets', id, 'defaultActiveAgent']);
    }
  }

  if (!agentNames.has(config.defaults.agent) && config.defaults.agent !== 'default') {
    fail(`defaults.agent "${config.defaults.agent}" is not defined in agents.`, [
      'defaults',
      'agent',
    ]);
  }

  return config;
}

export function defineConfig(config: RawConfig): ResolvedConfig {
  return validateConfig(rawConfigSchema.parse(config));
}

export type { Limits };
