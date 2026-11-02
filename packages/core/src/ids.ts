import { randomUUID } from 'node:crypto';

export type SessionId = string;
export type RunId = string;
export type SpanId = string;
export type EventId = string;
export type ApprovalId = string;

export const ID_PREFIX = {
  session: 'ses',
  run: 'run',
  span: 'spn',
  event: 'evt',
  approval: 'apr',
  call: 'call',
} as const;

function id(kind: keyof typeof ID_PREFIX): string {
  return `${ID_PREFIX[kind]}_${randomUUID()}`;
}

export const newSessionId = (): SessionId => id('session');
export const newRunId = (): RunId => id('run');
export const newSpanId = (): SpanId => id('span');
export const newEventId = (): EventId => id('event');
export const newApprovalId = (): ApprovalId => id('approval');

export function looksLikeId(prefix: keyof typeof ID_PREFIX, value: string): boolean {
  return value.startsWith(`${ID_PREFIX[prefix]}_`);
}
