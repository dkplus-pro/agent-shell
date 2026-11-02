import { z } from 'zod';
import type { Risk } from '../events/schema.js';
import { assertToolName } from './naming.js';

export type { Risk };

export const TOOL_SOURCES = ['code', 'plugin', 'mcp', 'runtime'] as const;
export type ToolSourceKind = (typeof TOOL_SOURCES)[number];

export type ToolJson = string | number | boolean | null | ToolJson[] | { [key: string]: ToolJson };
export type ToolOutput = ToolJson;

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

export interface ToolLogger {
  (
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    fields?: Record<string, unknown>,
  ): void;
}

export interface ToolContext {
  readonly sessionId: string;
  readonly runId: string;
  readonly spanId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly signal: AbortSignal;
  readonly workspaceRoot: string;
  readonly allowOutsideWorkspace: boolean;
  readonly log: ToolLogger;
  /** Workspace-guarded absolute path resolution; throws WorkspaceBoundaryError on escape. */
  resolveWorkspacePath(input: string): string;
}

/**
 * User-facing tool contract (docs/01-architecture.md §6.2). `risk` is mandatory:
 * a missing declaration is a registration error, never a default.
 */
export interface ToolDefinition<TArgs = ToolJson, TResult = ToolOutput> {
  name: string;
  description: string;
  schema: z.ZodType<TArgs>;
  risk: Risk;
  timeoutMs?: number;
  idempotent?: boolean;
  execute: (args: TArgs, ctx: ToolContext) => Promise<TResult>;
}

export function defineTool<TArgs extends ToolJson, TResult extends ToolOutput>(
  definition: ToolDefinition<TArgs, TResult>,
): ToolDefinition<TArgs, TResult> {
  assertToolName(definition.name);
  if (definition.risk === undefined) {
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['risk'],
        message: `Tool ${definition.name} must declare a risk level`,
      },
    ]);
  }
  return definition;
}

export function toolOutputToText(output: ToolOutput): string {
  if (typeof output === 'string') return output;
  if (output === null) return 'null';
  return JSON.stringify(output);
}
