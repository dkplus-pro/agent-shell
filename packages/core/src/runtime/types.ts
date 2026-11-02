import type { Risk, RunStatus, TokenUsage } from '../events/schema.js';
import type { Limits } from '../limits.js';
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from '../approvals/policy.js';
import type { ToolSourceKind } from '../tools/types.js';

export type { ApprovalDecision, ApprovalHandler, ApprovalRequest };

export interface RunOptions {
  task: string;
  /** preset key, defaults to config.defaults.preset */
  preset?: string;
  /** provider:model override */
  provider?: string;
  sessionId?: string;
  /** Reuse an existing session/thread (resume). */
  resume?: boolean;
  approvalHandler?: ApprovalHandler;
  yolo?: boolean;
  allowOutsideWorkspace?: boolean;
  signal?: AbortSignal;
  /** Emits every token as it arrives; used by the CLI renderer. */
  onToken?: (token: string) => void;
  onEvent?: (event: import('../events/schema.js').AgentEvent) => void;
  onApproval?: (request: ApprovalRequest) => Promise<ApprovalDecision>;
  quiet?: boolean;
}

export interface RunSummary {
  runId: string;
  sessionId: string;
  status: RunStatus;
  output: string;
  usage: TokenUsage;
  stepCount: number;
  subagentCount: number;
  approvalCount: number;
  durationMs: number;
  tracePath: string;
  preset: string;
  provider: string;
  model: string;
  error?: { name: string; code?: string; message: string };
}

export interface SpanNode {
  spanId: string;
  parentSpanId?: string;
  kind: 'run' | 'node' | 'llm' | 'tool' | 'subagent' | 'approval';
  label: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  events: import('../events/schema.js').AgentEvent[];
  children: SpanNode[];
  meta: {
    risk?: Risk;
    source?: ToolSourceKind;
    usage?: TokenUsage;
    status?: RunStatus;
    approvalDecision?: ApprovalDecision['decision'];
    truncated?: boolean;
    depth?: number;
    pattern?: 'spawn' | 'supervisor' | 'swarm';
    isError?: boolean;
  };
}

export interface RunListEntry {
  runId: string;
  sessionId: string;
  startedAt: string;
  status: RunStatus;
  provider: string;
  model: string;
  durationMs: number;
  totalTokens: number;
  stepCount: number;
  approvalCount: number;
  subagentCount: number;
  tracePath: string;
}

export interface SessionRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastProvider?: string;
  lastModel?: string;
  messageCount?: number;
}

export interface SubagentBudgetState {
  depth: number;
  spawned: number;
}

export type RuntimeLimits = Limits;
