/**
 * REPL slash-commands (docs/03 §2). Dispatch is a pure function over injected
 * data sources so it is unit-testable without a TTY.
 */
import { parseModelRef, type ResolvedConfig } from '@agent-shell/core';

export interface ReplState {
  sessionId?: string;
  provider?: string;
  preset: string;
  resumed: boolean;
  turnCount: number;
}

export interface ReplCommandDeps {
  state: ReplState;
  config: ResolvedConfig;
  tools(source: string | undefined): string[];
  plugins(): string[];
  mcp(): string[];
  providers(): string[];
  sessions(): Promise<string[]>;
  history(n: number): string[];
  trace(): string[];
  configView(): string[];
  newSession(): void;
}

export type ReplCommandResult =
  | { kind: 'output'; lines: string[] }
  | { kind: 'exit'; code: number }
  | { kind: 'error'; message: string };

export const REPL_COMMANDS = [
  '/help',
  '/provider [provider:model]',
  '/preset [name]',
  '/tools [source]',
  '/plugins',
  '/mcp',
  '/trace',
  '/history [n]',
  '/new',
  '/sessions',
  '/session',
  '/config',
  '/quit',
  '/exit',
] as const;

const HELP_LINES: string[] = [
  'REPL 命令:',
  '  /help                      显示此帮助',
  '  /provider [provider:model] 查看/切换下一个 run 的 provider',
  '  /preset [name]             查看/切换预设 (single / supervisor / swarm)',
  '  /tools [source]            列出工具及风险等级 (code|plugin|mcp|runtime)',
  '  /plugins                   插件状态',
  '  /mcp                       MCP server 状态',
  '  /trace                     当前 run 的 trace 路径与摘要',
  '  /history [n]               最近 n 条对话 (默认 10)',
  '  /new                       新建会话',
  '  /sessions                  会话列表',
  '  /session                   当前会话信息',
  '  /config                    有效配置 (密钥脱敏)',
  '  /quit, /exit               退出',
  '',
  'Ctrl+C: 第一次取消当前 run；第二次退出进程。审批提示中 Ctrl+C 视为拒绝。',
];

export function parseReplLine(line: string): { command: string; argument: string } | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const space = trimmed.search(/\s/);
  if (space === -1) return { command: trimmed.toLowerCase(), argument: '' };
  return {
    command: trimmed.slice(0, space).toLowerCase(),
    argument: trimmed.slice(space + 1).trim(),
  };
}

export async function dispatchReplCommand(
  line: string,
  deps: ReplCommandDeps,
): Promise<ReplCommandResult> {
  const parsed = parseReplLine(line);
  if (parsed === undefined) return { kind: 'error', message: `Not a REPL command: ${line}` };
  const { command, argument } = parsed;

  switch (command) {
    case '/help':
      return { kind: 'output', lines: HELP_LINES };

    case '/provider': {
      if (argument.length === 0) {
        const current = deps.state.provider ?? deps.config.defaults.provider ?? '(config default)';
        return { kind: 'output', lines: [`provider: ${current}`] };
      }
      try {
        parseModelRef(argument);
      } catch (error) {
        return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
      }
      const previous = deps.state.provider ?? deps.config.defaults.provider ?? '';
      deps.state.provider = argument;
      const lines = [`switched provider → ${argument} (applies to the next run)`];
      // Cross-provider continuation of one thread is best-effort (docs/01 §5.3):
      // message formats differ, so warn before the user hits an opaque provider error.
      if (
        previous.length > 0 &&
        parseModelRef(previous).providerId !== parseModelRef(argument).providerId &&
        deps.state.turnCount > 0
      ) {
        lines.push(
          'warn: 当前会话已有历史且跨 provider 续用同一 thread 仅 best-effort，若模型报错请用 /new 新建会话',
        );
      }
      return { kind: 'output', lines };
    }

    case '/preset': {
      if (argument.length === 0) {
        return { kind: 'output', lines: [`preset: ${deps.state.preset}`] };
      }
      const known = Object.keys(deps.config.presets);
      if (argument !== 'single' && !known.includes(argument)) {
        return {
          kind: 'error',
          message: `Unknown preset "${argument}". Defined presets: ${known.length > 0 ? known.join(', ') : '(only implicit single)'}`,
        };
      }
      deps.state.preset = argument;
      return { kind: 'output', lines: [`switched preset → ${argument} (applies to the next run)`] };
    }

    case '/tools': {
      const source = argument.length === 0 ? undefined : argument;
      if (source !== undefined && !['code', 'plugin', 'mcp', 'runtime'].includes(source)) {
        return {
          kind: 'error',
          message: `Unknown tool source "${source}"; expected code|plugin|mcp|runtime.`,
        };
      }
      return { kind: 'output', lines: deps.tools(source) };
    }

    case '/plugins':
      return { kind: 'output', lines: deps.plugins() };

    case '/mcp':
      return { kind: 'output', lines: deps.mcp() };

    case '/trace':
      return { kind: 'output', lines: deps.trace() };

    case '/history': {
      let count = 10;
      if (argument.length > 0) {
        const parsedCount = Number(argument);
        if (!Number.isInteger(parsedCount) || parsedCount <= 0) {
          return {
            kind: 'error',
            message: `/history expects a positive number, got "${argument}"`,
          };
        }
        count = parsedCount;
      }
      return { kind: 'output', lines: deps.history(count) };
    }

    case '/new':
      deps.newSession();
      return {
        kind: 'output',
        lines: [`new session: ${deps.state.sessionId ?? '(created on next run)'}`],
      };

    case '/sessions':
      return { kind: 'output', lines: await deps.sessions() };

    case '/session':
      return {
        kind: 'output',
        lines: [
          `session: ${deps.state.sessionId ?? '(pending — created on first run)'}`,
          `turns: ${deps.state.turnCount}`,
          `provider: ${deps.state.provider ?? deps.config.defaults.provider ?? '(config default)'}`,
          `preset: ${deps.state.preset}`,
          `resumed: ${String(deps.state.resumed)}`,
        ],
      };

    case '/config':
      return { kind: 'output', lines: deps.configView() };

    case '/quit':
    case '/exit':
      return { kind: 'exit', code: 0 };

    default:
      return {
        kind: 'error',
        message: `Unknown command "${command}". Type /help for the command list.`,
      };
  }
}
