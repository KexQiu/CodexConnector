import { parseInteraction } from '../../src/tasks/interaction-policy.ts';

export const inputQuestions = [
  { id: 'color', header: '颜色', question: '请选择测试颜色。', labels: ['蓝色', '红色'] },
  { id: 'language', header: '语言', question: '请选择测试语言。', labels: ['中文', '英文'] },
];
export function inputPrompt(cancel = false) {
  const questions = inputQuestions.map(({ labels, ...q }) => ({
    ...q,
    options: labels.map((label) => ({ label, description: `使用${label}作为测试答案。` })),
  }));
  return `This is a harmless test of the real request_user_input tool. Call request_user_input exactly once with these two questions in the given order: ${JSON.stringify(questions)}. Use the question IDs and option labels exactly as written, with no recommended suffix. Do not ask in prose, do not provide default answers, and wait for the user's tool response. Do not use any other tool, read files or personal data, write files, or access the network. After the response, do not ask again. ${cancel ? 'If the response is empty or cancelled, reply exactly M4_INPUT_CANCELLED and stop.' : 'When both answers are received, reply on one line: M4_INPUT_OK followed by the actual two answers, and stop.'}`;
}
export function validateInputRequest(request, directory) {
  const parsed = parseInteraction(request.method, request.params, directory);
  if (parsed.method !== 'item/tool/requestUserInput')
    throw new Error('Expected a user-input request');
  const questions = parsed.params.questions;
  if (questions.length !== inputQuestions.length) throw new Error('Unexpected question count');
  for (const [index, expected] of inputQuestions.entries()) {
    const question = questions[index];
    if (
      question.id !== expected.id ||
      JSON.stringify(question.options?.map((o) => o.label)) !== JSON.stringify(expected.labels)
    )
      throw new Error('Unexpected question identity or options');
  }
  return parsed;
}
/** Admission is deliberately narrower than production. Identity checks still run in FeishuInbox. */
export function allowedInputMessage(content, approvalId) {
  if (!approvalId || typeof content !== 'string') return false;
  try {
    const { text } = JSON.parse(content);
    if (typeof text !== 'string') return false;
    const match = text.trim().match(/^\/回答\s+(\S+)\s+([12])\s+(蓝色|中文)$/);
    return (
      !!match &&
      match[1].length >= 8 &&
      approvalId.startsWith(match[1]) &&
      (match[2] === '1' ? match[3] === '蓝色' : match[3] === '中文')
    );
  } catch {
    return false;
  }
}
