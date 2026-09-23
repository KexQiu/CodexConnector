export const TASK_STATUSES = [
  'queued',
  'starting',
  'running',
  'completed',
  'failed',
  'interrupted',
  'unknown',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type FailurePhase = 'thread_start' | 'turn_start' | 'execution';

export interface OwnerIdentity {
  tenantKey: string;
  appId: string;
  openId: string;
}

export interface ThreadRecord {
  threadId: string;
  owner: OwnerIdentity;
  origin: 'gateway';
  projectKey: string;
  /** Canonical execution directory, including the specific checkout/worktree. */
  cwd: string;
  createdAtMs: number;
}

/** One user submission; a thread may have many tasks/turns over time. */
export interface TaskRecord {
  taskId: string;
  requestKey: string;
  owner: OwnerIdentity;
  projectKey: string;
  cwd: string;
  threadId: string | null;
  turnId: string | null;
  status: TaskStatus;
  waiting: { approval: boolean; userInput: boolean };
  failurePhase: FailurePhase | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ApprovalCorrelation {
  approvalId: string;
  connectionEpoch: string;
  rpcRequestId: string | number;
  taskId: string;
  threadId: string;
  turnId: string | null;
}

const TERMINAL: ReadonlySet<TaskStatus> = new Set(['completed', 'failed', 'interrupted']);
const LOCKED: ReadonlySet<TaskStatus> = new Set(['starting', 'running', 'unknown']);
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ['starting', 'failed', 'interrupted'],
  starting: ['running', 'completed', 'failed', 'interrupted', 'unknown'],
  running: ['completed', 'failed', 'interrupted', 'unknown'],
  unknown: ['running', 'completed', 'failed', 'interrupted'],
  completed: [],
  failed: [],
  interrupted: [],
};

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL.has(status);
}

export function holdsExecutionLock(status: TaskStatus): boolean {
  return LOCKED.has(status);
}

/** A structural guard; the caller still needs authoritative event/reconciliation evidence. */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}
