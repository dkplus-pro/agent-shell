import { randomUUID } from 'node:crypto';
import { tool, type StructuredTool, type ToolRunnableConfig } from '@langchain/core/tools';
import { z } from 'zod';
import { ConfigError } from '../errors/index.js';
import type { RegisteredTool } from './registry.js';
import type { ToolOutput } from './types.js';

/**
 * Everything risky stays in `ToolExecutor`: the bridge only forwards a bound
 * call so approval interrupts, events and truncation keep one code path.
 */
export type RegisteredToolRunner = (
  tool: RegisteredTool,
  args: Record<string, unknown>,
  callId: string,
) => Promise<ToolOutput>;

export function toLangChainTools(
  tools: readonly RegisteredTool[],
  run: RegisteredToolRunner,
): StructuredTool[] {
  return tools.map((registered) => {
    if (!(registered.schema instanceof z.ZodObject)) {
      throw new ConfigError(
        `Tool "${registered.name}" must declare a zod object schema to be bound to a provider.`,
      );
    }
    const schema = registered.schema;
    return tool(
      async (input: Record<string, unknown>, config?: ToolRunnableConfig): Promise<ToolOutput> =>
        run(registered, input ?? {}, config?.toolCall?.id ?? `call_${randomUUID()}`),
      {
        name: registered.name,
        description: registered.description,
        schema,
      },
    ) as StructuredTool;
  });
}

export interface ToolJsonSchema {
  name: string;
  description: string;
  jsonSchema: Record<string, unknown>;
}

/** Provider binding fallback for backends that take raw JSON Schema. */
export function toolJsonSchemas(tools: readonly RegisteredTool[]): ToolJsonSchema[] {
  return tools.map((registered) => ({
    name: registered.name,
    description: registered.description,
    jsonSchema: z.toJSONSchema(registered.schema) as Record<string, unknown>,
  }));
}
