/**
 * The renderer owns every stdout/stderr write in the CLI (docs/03 §1, §4):
 * results go to stdout, diagnostics/progress to stderr, and `--json` mode
 * keeps stdout NDJSON-only. Commands and the REPL never touch the streams.
 */
import type { AgentEvent, RunSummary } from '@agent-shell/core';
import picocolors from 'picocolors';
import type { GlobalFlags } from '../flags.js';

export type RenderMode = 'human' | 'json' | 'quiet';

export interface Renderer {
  readonly mode: RenderMode;
  readonly verbose: boolean;
  /** Streamed model token (human mode only; suppressed for --json/--quiet). */
  token(text: string): void;
  /** One AgentEvent: NDJSON line in json mode, tool/approval cards in human mode. */
  event(event: AgentEvent): void;
  /** Final answer text. */
  answer(text: string): void;
  /** Run summary block (docs/03 §4); human mode only. */
  summary(summary: RunSummary): void;
  /** Result lines (tables, trees, lists): stdout in every mode. */
  lines(lines: string[]): void;
  /** Diagnostic/progress line: stderr always. */
  progress(line: string): void;
  /** Error line: stderr always. */
  error(message: string): void;
  /** Approval prompt block written before an interactive question (docs/03 §3). */
  promptBlock(lines: string[]): void;
  /** Ensure the streamed answer terminates with a newline before other output. */
  endStream(): void;
}

interface PendingTool {
  name: string;
  source: string;
  risk: string;
}

export function createRenderer(flags: GlobalFlags, env: NodeJS.ProcessEnv = process.env): Renderer {
  const mode: RenderMode = flags.json ? 'json' : flags.quiet ? 'quiet' : 'human';
  const useColor =
    mode === 'human' &&
    flags.noColor !== true &&
    env['AGENT_SHELL_NO_COLOR'] === undefined &&
    process.stdout.isTTY === true;
  const colors = picocolors.createColors(useColor);
  const out = (line: string): void => void process.stdout.write(line);
  const err = (line: string): void => void process.stderr.write(`${line}\n`);

  const pending = new Map<string, PendingTool>();
  let streamed = false;

  const errorLine = (message: string): void => {
    err(`${colors.red('error')} ${message}`);
  };

  const card = (tool: PendingTool, durationMs: number): string =>
    `${colors.cyan('→')} ${colors.bold('tool')} ${colors.yellow(tool.name)} [${tool.source} · ${tool.risk}] ${formatMs(durationMs)}`;

  return {
    mode,
    verbose: flags.verbose,

    token(text: string): void {
      if (mode !== 'human') return;
      streamed = true;
      out(text);
    },

    event(event: AgentEvent): void {
      if (mode === 'json') {
        out(`${JSON.stringify(event)}\n`);
        return;
      }
      if (mode !== 'human') {
        if (event.type === 'run.error') errorLine(eventErrorText(event));
        return;
      }
      switch (event.type) {
        case 'tool.started': {
          const payload = event.payload;
          pending.set(String(payload['callId']), {
            name: String(payload['name'] ?? 'tool'),
            source: String(payload['source'] ?? 'code'),
            risk: String(payload['risk'] ?? 'read'),
          });
          return;
        }
        case 'tool.finished': {
          const tool = take(pending, event);
          const durationMs = numberOr(event.payload['durationMs'], 0);
          const preview =
            typeof event.payload['resultPreview'] === 'string'
              ? event.payload['resultPreview']
              : '';
          const failed = event.payload['isError'] === true;
          err(`${card(tool, durationMs)}`);
          err(
            failed
              ? `${colors.red('←')} error ${formatBytes(Buffer.byteLength(preview, 'utf8'))}`
              : `${colors.green('←')} ok ${formatBytes(Buffer.byteLength(preview, 'utf8'))}`,
          );
          return;
        }
        case 'tool.error': {
          const tool = take(pending, event);
          err(`${card(tool, 0)}`);
          err(`${colors.red('←')} error ${eventErrorText(event)}`);
          return;
        }
        case 'tool.approval.decided': {
          const payload = event.payload;
          const decision = String(payload['decision']);
          const mark = decision === 'approve' ? colors.green('approve') : colors.red('deny');
          const reason = typeof payload['reason'] === 'string' ? ` (${payload['reason']})` : '';
          err(
            `${colors.yellow('⚠')} approval ${String(payload['name'] ?? '')} → ${mark} ${String(payload['actor'] ?? '')}${reason}`,
          );
          return;
        }
        case 'run.error': {
          this.error(eventErrorText(event));
          return;
        }
        case 'llm.started':
        case 'llm.completed':
        case 'graph.node.started':
        case 'graph.node.finished':
        case 'session.started':
        case 'session.resumed':
        case 'run.started':
          return;
        default:
          if (flags.verbose) err(`· ${event.type} ${summarizePayload(event.payload)}`);
          return;
      }
    },

    answer(text: string): void {
      if (mode === 'json') return; // the answer rides in llm.completed events
      if (streamed) {
        this.endStream();
        return;
      }
      if (text.length > 0) out(`${text}\n`);
    },

    summary(summary: RunSummary): void {
      if (mode !== 'human') return;
      this.endStream();
      const status =
        summary.status === 'ok' ? colors.green(summary.status) : colors.red(summary.status);
      const ref =
        summary.model.length > 0 ? `${summary.provider}:${summary.model}` : summary.provider;
      err('');
      out(`${shortId(summary.runId)}  ${status}  ${formatMs(summary.durationMs)}  ${ref}\n`);
      out(
        `steps=${summary.stepCount}  tokens=${summary.usage.totalTokens.toLocaleString('en-US')}  ` +
          `approvals=${summary.approvalCount}  subagents=${summary.subagentCount}\n`,
      );
      out(`trace: ${summary.tracePath}\n`);
    },

    lines(lines: string[]): void {
      for (const line of lines) out(`${line}\n`);
    },

    progress(line: string): void {
      err(line);
    },

    error(message: string): void {
      err(`${colors.red('error')} ${message}`);
    },

    promptBlock(lines: string[]): void {
      for (const line of lines) out(`${line}\n`);
    },

    endStream(): void {
      if (streamed) {
        out('\n');
        streamed = false;
      }
    },
  };
}

function take(pending: Map<string, PendingTool>, event: AgentEvent): PendingTool {
  const callId = String(event.payload['callId']);
  const tool = pending.get(callId);
  pending.delete(callId);
  const payloadName = typeof event.payload['name'] === 'string' ? event.payload['name'] : 'tool';
  return (
    tool ?? {
      name: payloadName,
      source: String(event.payload['source'] ?? 'code'),
      risk: String(event.payload['risk'] ?? 'read'),
    }
  );
}

function eventErrorText(event: AgentEvent): string {
  const error = event.payload['error'];
  if (error !== null && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error ?? event.type);
}

function summarizePayload(payload: Record<string, unknown>): string {
  const text = JSON.stringify(payload) ?? '';
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Plain fixed-width table used for every `list` command result (docs/03 §8.1). */
export function formatTable(header: string[], rows: string[][]): string[] {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const pad = (cells: string[]): string =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? cell.length))
      .join('  ')
      .trimEnd();
  return [pad(header), ...rows.map(pad)];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function shortId(id: string): string {
  const separator = id.indexOf('_');
  if (separator <= 0) return id;
  const rest = id.slice(separator + 1);
  return rest.length <= 4 ? id : `${id.slice(0, separator + 5)}...`;
}
