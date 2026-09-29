export {
  projectlessCandidateVersion,
  projectlessPolicyRevision,
  disabledFeatures,
  projectlessCandidateConfig,
  projectlessProbeEnvironment,
} from '../../src/conversations/policy.ts';

/** Newer Codex sends tools in input.additional_tools, not just the top-level tools array. */
export function declaredTools(request) {
  const names = new Set();
  const visit = (tools, namespace = '') => {
    if (!Array.isArray(tools)) throw new Error('Unrecognized tool declarations');
    for (const tool of tools) {
      if (!tool || typeof tool !== 'object') throw new Error('Unrecognized tool declaration');
      const name = tool.name ?? tool.function?.name;
      if (tool.type === 'namespace') {
        if (typeof name !== 'string') throw new Error('Unnamed tool namespace');
        visit(tool.tools, namespace + name + '.');
      } else {
        if (name !== undefined && !['function', 'custom'].includes(tool.type))
          throw new Error('Unrecognized named tool type');
        if (typeof name !== 'string' && typeof tool.type !== 'string')
          throw new Error('Unnamed tool');
        if (tool.namespace !== undefined && typeof tool.namespace !== 'string')
          throw new Error('Unrecognized tool namespace');
        const prefix = namespace + (tool.namespace ? `${tool.namespace}.` : '');
        names.add(prefix + (name ?? tool.type));
        // Nested code-mode capabilities are in the wrapper's model-visible description.
        // The wrapper itself is also prohibited, so an unknown nested format cannot pass.
        if (typeof tool.description === 'string')
          for (const match of tool.description.matchAll(/### `([^`]+)`/g))
            names.add(`${prefix}${name ?? tool.type}/${match[1]}`);
      }
    }
  };
  if (request.tools != null) visit(request.tools);
  if (!Array.isArray(request.input)) throw new Error('Missing model input');
  for (const item of request.input) if (item.type === 'additional_tools') visit(item.tools);
  return [...names].sort();
}

// User approved the built-in clock on 2026-09-28. No other tool exception is implied.
const inputTools = new Set([
  'request_user_input',
  'request_user_input_async',
  'functions.request_user_input',
  'functions.request_user_input_async',
  'clock.curr_time',
  'functions.exec/clock__curr_time',
]);
export function forbiddenTools(request, wrapperReceipts = {}) {
  return declaredTools(request).filter((name) => {
    if (inputTools.has(name)) return false;
    // Residual wrapper declarations are tolerable only after this process actually rejected
    // that executor. No output, generic errors and config echoes are never sufficient.
    if (name === 'functions.exec') return !rejectedToolCall(wrapperReceipts.exec ?? []);
    if (name === 'functions.wait') return !rejectedToolCall(wrapperReceipts.wait ?? []);
    return true;
  });
}

export function allowedClockCall(outputs, startedAt, endedAt) {
  return (
    outputs.length > 0 &&
    outputs.every(({ output }) => {
      if (typeof output !== 'string') return false;
      const match = /^It is (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC\.$/.exec(output);
      if (!match) return false;
      const time = Date.parse(`${match[1]}T${match[2]}Z`);
      return time >= startedAt - 1000 && time <= endedAt + 1000;
    })
  );
}

export function toolOutputs(requests, callId) {
  return requests.flatMap((request) =>
    (request.input ?? []).filter(
      (item) =>
        ['function_call_output', 'custom_tool_call_output'].includes(item.type) &&
        item.call_id === callId,
    ),
  );
}

export function returnedAgentList(outputs) {
  return outputs.some((item) => {
    if (typeof item.output !== 'string') return false;
    try {
      const value = JSON.parse(item.output);
      return value !== null && typeof value === 'object' && Array.isArray(value.agents);
    } catch {
      return false;
    }
  });
}

/** Absence of an output, or a generic error, cannot prove that a tool wasn't executed. */
export function rejectedToolCall(outputs) {
  return (
    outputs.length > 0 &&
    outputs.every((item) => {
      if (typeof item.output !== 'string') return false;
      // Reviewed transport rejections from the candidate binary, not model refusal text.
      // Unknown/new error formats must fail closed until inspected.
      return /^(?:unsupported (?:custom tool )?call: [\w./-]+|code-mode host is disabled)$/.test(
        item.output,
      );
    })
  );
}

/** Recovery metadata is not a policy receipt: check again after every actual turn. */
export function emptyTurnEnvironments(response) {
  return Array.isArray(response?.thread?.environments) && response.thread.environments.length === 0;
}
