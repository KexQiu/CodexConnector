import { describe, expect, it } from 'vitest';
import {
  allowedPhoneControlMessage,
  phoneSteerText,
  validatePhoneWaitItem,
} from '../scripts/gates/phone-control-fixture.mjs';

const task = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const message = (text) => JSON.stringify({ text });
describe('Live phone control probe guards', () => {
  it('admits only the current task and current exact phone action', () => {
    const steer = message(`/补充 aaaaaaaa ${phoneSteerText}`),
      interrupt = message(`/打断 ${task}`);
    expect(allowedPhoneControlMessage(steer, task, 'steer')).toBe(true);
    expect(allowedPhoneControlMessage(interrupt, task, 'interrupt')).toBe(true);
    expect(allowedPhoneControlMessage(steer, task, 'interrupt')).toBe(false);
    expect(allowedPhoneControlMessage(interrupt, task, 'steer')).toBe(false);
    for (const invalid of [
      '/新建 fixture run',
      '/打断 aaaaaaa',
      '/打断 bbbbbbbb',
      '/打断 aaaaaaaa extra',
      `/补充 aaaaaaaa ${phoneSteerText}\n/新建 fixture run`,
    ])
      expect(allowedPhoneControlMessage(message(invalid), task, 'interrupt')).toBe(false);
    expect(allowedPhoneControlMessage(message('/补充 aaaaaaaa unexpected'), task, 'steer')).toBe(
      false,
    );
    expect(allowedPhoneControlMessage(steer, null, 'steer')).toBe(false);
    expect(allowedPhoneControlMessage(steer, task, null)).toBe(false);
    expect(allowedPhoneControlMessage('{', task, 'steer')).toBe(false);
  });
  it('requires the fixed running wait command in the fixture directory', () => {
    const item = {
      type: 'commandExecution',
      id: 'item-1',
      cwd: '/private/tmp',
      status: 'inProgress',
      command: '/bin/sleep 900',
    };
    expect(() => validatePhoneWaitItem(item, '/private/tmp')).not.toThrow();
    expect(() =>
      validatePhoneWaitItem({ ...item, command: "/bin/zsh -lc '/bin/sleep 900'" }, '/private/tmp'),
    ).not.toThrow();
    for (const changed of [
      { ...item, command: '/bin/sleep 900; touch file' },
      { ...item, command: '/bin/sleep 901' },
      { ...item, cwd: '/Users' },
      { ...item, status: 'completed' },
      { ...item, type: 'fileChange' },
    ])
      expect(() => validatePhoneWaitItem(changed, '/private/tmp')).toThrow();
  });
});
