export const phoneSteerText = '这是补充指令测试，请继续等待。';
export const phoneWaitSeconds = 900;
const waitCommand = `/bin/sleep ${phoneWaitSeconds}`;
const allowedCommands = new Set([
  waitCommand,
  ...['-c', '-lc'].flatMap((flag) => [
    `/bin/zsh ${flag} '${waitCommand}'`,
    `/bin/zsh ${flag} "${waitCommand}"`,
  ]),
]);

export function phoneControlPrompt(directory) {
  return `This is a harmless test of phone steering and interruption. Run exactly ${JSON.stringify(waitCommand)} once via exec, in workdir ${JSON.stringify(directory)}, using the default sandbox, with yield_time_ms=1000. Keep this turn active until that sleep exits or the user interrupts it. If exec yields a process ID, use write_stdin only with empty chars to wait for that same process. Do not launch the sleep again. Do not read or write files, access the network, or invoke other tools or commands. A later user message asking you to keep waiting is expected. If the sleep finishes normally, reply M4_PHONE_WAIT_DONE and stop.`;
}

export function validatePhoneWaitItem(item, directory) {
  if (
    item?.type !== 'commandExecution' ||
    item.cwd !== directory ||
    !allowedCommands.has(item.command) ||
    item.status !== 'inProgress' ||
    typeof item.id !== 'string' ||
    !item.id
  )
    throw new Error('Expected only the fixed sleep command in the test directory');
}

/** Test admission only. The production inbox still validates identity and message IDs. */
export function allowedPhoneControlMessage(content, taskId, stage) {
  if (!taskId || !['steer', 'interrupt'].includes(stage) || typeof content !== 'string')
    return false;
  try {
    const { text } = JSON.parse(content);
    if (typeof text !== 'string') return false;
    const match = text.trim().match(/^\/(补充|打断) ([a-z0-9-]{8,36})(?: ([^\r\n]+))?$/);
    if (!match || !taskId.startsWith(match[2])) return false;
    return stage === 'steer'
      ? match[1] === '补充' && match[3] === phoneSteerText
      : match[1] === '打断' && match[3] === undefined;
  } catch {
    return false;
  }
}
