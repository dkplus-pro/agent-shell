import type { BudgetKind } from '../limits.js';

/**
 * Error taxonomy and exit-code mapping (docs/01-architecture.md §8.1,
 * docs/03-cli-and-trace.md §10). Exit codes are part of the public contract:
 * changing one requires an event/config schema discussion first.
 */

export const EXIT_CODES = {
  ok: 0,
  unexpected: 1,
  config: 2,
  provider: 3,
  tool: 4,
  approvalDenied: 5,
  budget: 6,
  cancelled: 130,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export type ShellErrorCode =
  | 'UNEXPECTED'
  | 'CONFIG_INVALID'
  | 'CONFIG_MISSING_KEY'
  | 'NAME_CONFLICT'
  | 'PROVIDER_AUTH'
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_NETWORK'
  | 'PROVIDER_PROTOCOL'
  | 'PROVIDER_TIMEOUT'
  | 'TOOL_VALIDATION'
  | 'TOOL_EXECUTION'
  | 'TOOL_TIMEOUT'
  | 'TOOL_NOT_FOUND'
  | 'APPROVAL_DENIED'
  | 'BUDGET_EXCEEDED'
  | 'CANCELLED'
  | 'PLUGIN_INVALID'
  | 'PLUGIN_LOAD'
  | 'PLUGIN_API_VERSION'
  | 'MCP_CONNECT'
  | 'MCP_CALL'
  | 'MCP_TIMEOUT'
  | 'SUBAGENT_FAILED'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'HARD_DENY';

export interface ShellErrorDetails {
  code?: ShellErrorCode;
  message: string;
  cause?: unknown;
  fields?: Record<string, unknown>;
}

export class ShellError extends Error {
  code: ShellErrorCode;
  readonly exitCode: ExitCode;
  readonly fields: Record<string, unknown>;
  override readonly cause: unknown;

  constructor(name: string, exitCode: ExitCode, details: ShellErrorDetails) {
    super(redactErrorMessage(details.message));
    this.name = name;
    this.code = details.code ?? 'UNEXPECTED';
    this.exitCode = exitCode;
    this.fields = details.fields ?? {};
    this.cause = details.cause;
  }

  toJSON(): { name: string; code: string; message: string } {
    return { name: this.name, code: this.code, message: this.message };
  }
}

/**
 * Secrets never leave through an error message: construction is the last place
 * where we can cheaply scrub provider credentials echoed by upstream SDKs.
 */
function redactErrorMessage(message: string): string {
  return message
    .replace(
      /(api[_-]?key|authorization|x-api-key|token|secret|password)\s*[:=]\s*\S+/gi,
      '$1=[redacted]',
    )
    .replace(/(sk|pk|ant)-[A-Za-z0-9_-]{8,}/g, '[redacted-key]');
}

export class UnexpectedError extends ShellError {
  constructor(message: string, cause?: unknown) {
    super('UnexpectedError', EXIT_CODES.unexpected, { code: 'UNEXPECTED', message, cause });
  }
}

export class ConfigError extends ShellError {
  constructor(message: string, cause?: unknown, fields?: Record<string, unknown>) {
    super('ConfigError', EXIT_CODES.config, { code: 'CONFIG_INVALID', message, cause, fields });
  }
}

export class MissingSecretError extends ConfigError {
  constructor(variable: string) {
    super(
      `Missing required environment variable ${variable}. Set it before starting agent-shell.`,
      undefined,
      {
        code: 'CONFIG_MISSING_KEY',
        variable,
      },
    );
    this.code = 'CONFIG_MISSING_KEY';
  }
}

export class NameConflictError extends ConfigError {
  constructor(name: string, previous: string, incoming: string) {
    super(
      `Tool name "${name}" is registered twice (source ${previous} and ${incoming}).`,
      undefined,
      {
        code: 'NAME_CONFLICT',
        name,
      },
    );
    this.code = 'NAME_CONFLICT';
  }
}

export type ProviderErrorKind = 'auth' | 'rate-limit' | 'network' | 'protocol' | 'timeout';

export class ProviderError extends ShellError {
  constructor(kind: ProviderErrorKind, message: string, cause?: unknown) {
    const codeMap: Record<ProviderErrorKind, ShellErrorCode> = {
      auth: 'PROVIDER_AUTH',
      'rate-limit': 'PROVIDER_RATE_LIMIT',
      network: 'PROVIDER_NETWORK',
      protocol: 'PROVIDER_PROTOCOL',
      timeout: 'PROVIDER_TIMEOUT',
    };
    super('ProviderError', EXIT_CODES.provider, {
      code: codeMap[kind],
      message,
      cause,
      fields: { kind },
    });
  }
}

export class ToolError extends ShellError {
  constructor(message: string, cause?: unknown, code: ShellErrorCode = 'TOOL_EXECUTION') {
    super('ToolError', EXIT_CODES.tool, { code, message, cause });
  }
}

export class ToolValidationError extends ToolError {
  constructor(tool: string, message: string) {
    super(`Tool ${tool}: invalid arguments — ${message}`, undefined, 'TOOL_VALIDATION');
    this.name = 'ToolValidationError';
  }
}

export class ToolTimeoutError extends ToolError {
  constructor(tool: string, timeoutMs: number) {
    super(`Tool ${tool} timed out after ${timeoutMs}ms`, undefined, 'TOOL_TIMEOUT');
    this.name = 'ToolTimeoutError';
  }
}

export class UnknownToolError extends ToolError {
  constructor(tool: string) {
    super(`Unknown tool "${tool}"`, undefined, 'TOOL_NOT_FOUND');
    this.name = 'UnknownToolError';
  }
}

export class ApprovalDeniedError extends ShellError {
  constructor(tool: string, reason: string) {
    super('ApprovalDenied', EXIT_CODES.approvalDenied, {
      code: 'APPROVAL_DENIED',
      message: `Approval denied for ${tool}: ${reason}`,
      fields: { tool, reason },
    });
  }
}

export class BudgetExceededError extends ShellError {
  readonly kind: BudgetKind;
  readonly limit: number;
  readonly used: number;

  constructor(kind: BudgetKind, limit: number, used: number) {
    super('BudgetExceeded', EXIT_CODES.budget, {
      code: 'BUDGET_EXCEEDED',
      message: `Budget exceeded (${kind}): used ${used} of ${limit}`,
      fields: { kind, limit, used },
    });
    this.kind = kind;
    this.limit = limit;
    this.used = used;
  }
}

export class CancelledError extends ShellError {
  constructor(message = 'Run cancelled') {
    super('CancelledError', EXIT_CODES.cancelled, { code: 'CANCELLED', message });
  }
}

export class PluginError extends ShellError {
  constructor(message: string, cause?: unknown, startup = true, fields?: Record<string, unknown>) {
    super('PluginError', startup ? EXIT_CODES.config : EXIT_CODES.tool, {
      code: startup ? 'PLUGIN_INVALID' : 'PLUGIN_LOAD',
      message,
      cause,
      fields,
    });
  }
}

export class PluginApiVersionError extends PluginError {
  constructor(plugin: string, found: string, expected: string) {
    super(
      `Plugin ${plugin} declares apiVersion ${found}, shell provides ${expected}`,
      undefined,
      true,
      {
        code: 'PLUGIN_API_VERSION',
        plugin,
      },
    );
    this.name = 'PluginApiVersionError';
  }
}

export class McpError extends ShellError {
  constructor(message: string, cause?: unknown, code: ShellErrorCode = 'MCP_CALL') {
    super('McpError', EXIT_CODES.tool, { code, message, cause });
  }
}

export class SubagentError extends ShellError {
  constructor(message: string, cause?: unknown) {
    super('SubagentError', EXIT_CODES.tool, { code: 'SUBAGENT_FAILED', message, cause });
  }
}

export class WorkspaceBoundaryError extends ShellError {
  constructor(path: string, reason: string) {
    super('ToolError', EXIT_CODES.tool, {
      code: 'PATH_OUTSIDE_WORKSPACE',
      message: `Path "${path}" is outside the workspace (${reason})`,
      fields: { path, reason },
    });
    this.name = 'WorkspaceBoundaryError';
  }
}

export class HardDenyError extends ShellError {
  constructor(command: string) {
    super('ToolError', EXIT_CODES.tool, {
      code: 'HARD_DENY',
      message: `Command refused by the hard-deny policy: ${command}`,
      fields: { command },
    });
    this.name = 'HardDenyError';
  }
}

export function exitCodeFor(error: unknown): ExitCode {
  if (error instanceof ShellError) return error.exitCode;
  if (error instanceof Error && error.name === 'AbortError') return EXIT_CODES.cancelled;
  return EXIT_CODES.unexpected;
}

export function toErrorPayload(error: unknown): { name: string; code?: string; message: string } {
  if (error instanceof ShellError) return error.toJSON();
  if (error instanceof Error)
    return { name: error.name, message: redactErrorMessage(error.message) };
  return { name: 'UnknownError', message: redactErrorMessage(String(error)) };
}

export function isShellError(error: unknown, name?: string): error is ShellError {
  if (!(error instanceof ShellError)) return false;
  return name === undefined || error.name === name;
}
