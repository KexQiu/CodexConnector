import { describe, expect, it } from 'vitest';
import {
  allowedInputMessage,
  inputQuestions,
  validateInputRequest,
} from '../scripts/gates/input-fixture.mjs';

const approval = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const message = (text) => JSON.stringify({ text });
const request = () => ({
  method: 'item/tool/requestUserInput',
  params: {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-1',
    isBlocking: true,
    autoResolutionMs: null,
    questions: inputQuestions.map(({ labels, ...q }) => ({
      ...q,
      isOther: false,
      isSecret: false,
      options: labels.map((label) => ({ label, description: label })),
    })),
  },
});
describe('Live input probe admission guards', () => {
  it('admits only the current request and the exact question-answer pairs', () => {
    expect(allowedInputMessage(message('/回答 aaaaaaaa 1 蓝色'), approval)).toBe(true);
    expect(allowedInputMessage(message(`/回答 ${approval} 2 中文`), approval)).toBe(true);
    for (const text of [
      '/新建 fixture run',
      '/回答 bbbbbbbb 1 蓝色',
      '/回答 aaaaaaaa 1 中文',
      '/回答 aaaaaaaa 2 蓝色',
      '/回答 aaaaaaa 1 蓝色',
      '/回答 aaaaaaaa 1 蓝色\n/新建 fixture run',
    ])
      expect(allowedInputMessage(message(text), approval)).toBe(false);
    expect(allowedInputMessage(message('/回答 aaaaaaaa 1 蓝色'), null)).toBe(false);
    expect(allowedInputMessage('{', approval)).toBe(false);
  });
  it('accepts both input modes but requires the expected question identities and labels', () => {
    expect(validateInputRequest(request(), '/private/tmp').params.questions).toHaveLength(2);
    const nonBlocking = request();
    nonBlocking.params.isBlocking = false;
    expect(validateInputRequest(nonBlocking, '/private/tmp').params.isBlocking).toBe(false);
    for (const alter of [
      (r) => (r.params.questions[0].id = 'other'),
      (r) => (r.params.questions[0].options[0].label = '蓝色（推荐）'),
      (r) => (r.params.questions[0].isSecret = true),
      (r) => r.params.questions.pop(),
      (r) => (r.method = 'item/tool/call'),
    ]) {
      const changed = request();
      alter(changed);
      expect(() => validateInputRequest(changed, '/private/tmp')).toThrow();
    }
  });
});
