import { describe, expect, it } from 'vitest';
import {
  fileContent,
  fileTarget,
  validateFileRequest,
  validateFileOutcome,
} from '../scripts/gates/file-fixture.mjs';

const directory = '/private/tmp';
const request = {
  method: 'item/fileChange/requestApproval',
  params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', grantRoot: null },
};
const observation = () => ({
  changes: [{ path: fileTarget(directory, 'accept'), kind: { type: 'add' }, diff: fileContent }],
});
describe('Live file approval probe guards', () => {
  it('accepts only the observed fixed file addition', () => {
    expect(validateFileRequest(request, observation(), directory, 'accept').method).toBe(
      request.method,
    );
    const plus = observation();
    plus.changes[0].diff = '+' + fileContent;
    expect(
      validateFileRequest(request, plus, directory, 'accept').params.gatewayChanges,
    ).toHaveLength(1);
  });
  it('refuses missing details, other files, content changes, moves and broad grants', () => {
    expect(() => validateFileRequest(request, undefined, directory, 'accept')).toThrow();
    for (const change of [
      (o) => (o.changes[0].path = '/private/tmp/another-file'),
      (o) => (o.changes[0].diff = fileContent + 'unexpected\n'),
      (o) => (o.changes[0].kind = { type: 'update', move_path: '/private/other' }),
      (o) => o.changes.push(o.changes[0]),
    ]) {
      const o = observation();
      change(o);
      expect(() => validateFileRequest(request, o, directory, 'accept')).toThrow();
    }
    expect(() =>
      validateFileRequest(
        { ...request, params: { ...request.params, grantRoot: '/private' } },
        observation(),
        directory,
        'accept',
      ),
    ).toThrow();
    expect(() => validateFileRequest(request, observation(), directory, 'cancel')).toThrow();
  });
  it('accepts observed cancellation shapes only when no file was created', () => {
    const cancelled = { taskStatus: 'interrupted', toolStatus: 'failed', fileCreated: false };
    expect(() => validateFileOutcome('cancel', cancelled)).not.toThrow();
    expect(() =>
      validateFileOutcome('cancel', {
        ...cancelled,
        toolStatus: 'declined',
        taskStatus: 'completed',
      }),
    ).not.toThrow();
    for (const changed of [
      { ...cancelled, taskStatus: 'completed' },
      { ...cancelled, taskStatus: 'failed' },
      { ...cancelled, toolStatus: 'completed' },
      { ...cancelled, fileCreated: true },
      { ...cancelled, fileCreated: undefined },
    ])
      expect(() => validateFileOutcome('cancel', changed)).toThrow();
  });
  it('requires successful execution and exact disk content after accepting', () => {
    const accepted = {
      taskStatus: 'completed',
      toolStatus: 'completed',
      fileCreated: true,
      fileContentMatches: true,
    };
    expect(() => validateFileOutcome('accept', accepted)).not.toThrow();
    for (const changed of [
      { ...accepted, fileCreated: false },
      { ...accepted, fileContentMatches: false },
      { ...accepted, taskStatus: 'interrupted' },
      { ...accepted, toolStatus: 'failed' },
    ])
      expect(() => validateFileOutcome('accept', changed)).toThrow();
    expect(() => validateFileOutcome('other', accepted)).toThrow();
  });
});
