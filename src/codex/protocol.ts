import type { ClientRequest } from './generated/ClientRequest.js';
import type { ThreadStartParams } from './generated/v2/ThreadStartParams.js';
import type { ThreadResumeParams } from './generated/v2/ThreadResumeParams.js';

export type { ClientRequest } from './generated/ClientRequest.js';
export type { ServerRequest } from './generated/ServerRequest.js';
export type { ServerNotification } from './generated/ServerNotification.js';
export type { RequestId } from './generated/RequestId.js';

export type RequestParams<Method extends ClientRequest['method']> = Extract<
  ClientRequest,
  { method: Method }
>['params'];

/** Both new and resumed Gateway threads must explicitly apply this baseline. */
export const GATEWAY_THREAD_POLICY = {
  sandbox: 'workspace-write',
  approvalPolicy: 'on-request',
  approvalsReviewer: 'user',
} as const satisfies Pick<ThreadStartParams, 'sandbox' | 'approvalPolicy' | 'approvalsReviewer'> &
  Pick<ThreadResumeParams, 'sandbox' | 'approvalPolicy' | 'approvalsReviewer'>;
