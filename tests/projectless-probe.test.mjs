import { attestedPolicyMatches } from '../src/conversations/capability.ts';
import { describe, expect, it } from 'vitest';
import { URL } from 'node:url';
import { projectlessProvider } from '../scripts/gates/projectless-provider.mjs';
import {
  declaredTools,
  allowedClockCall,
  emptyTurnEnvironments,
  forbiddenTools,
  projectlessCandidateConfig,
  projectlessProbeEnvironment,
  rejectedToolCall,
  returnedAgentList,
  toolOutputs,
} from '../scripts/gates/projectless-support.mjs';

describe('NP0 evidence cannot grant a capability from missing or simulated data', () => {
  it('detects both top-level tools and the additional_tools namespace wire format', () => {
    const request = {
      tools: [{ type: 'function', name: 'exec_command' }, { type: 'web_search' }],
      input: [
        {
          type: 'additional_tools',
          tools: [
            {
              type: 'namespace',
              name: 'collaboration',
              tools: [{ type: 'function', name: 'list_agents' }],
            },
          ],
        },
      ],
    };
    expect(declaredTools(request)).toEqual([
      'collaboration.list_agents',
      'exec_command',
      'web_search',
    ]);
    expect(forbiddenTools({ input: request.input })).toEqual(['collaboration.list_agents']);
  });

  it('includes nested code-mode tools even when the top-level tools field is absent', () => {
    const request = {
      input: [
        {
          type: 'additional_tools',
          tools: [
            {
              type: 'namespace',
              name: 'functions',
              tools: [
                { type: 'custom', name: 'exec', description: '### `clock__curr_time`\nRead clock' },
              ],
            },
          ],
        },
      ],
    };
    expect(declaredTools(request)).toEqual(['functions.exec', 'functions.exec/clock__curr_time']);
    expect(forbiddenTools(request)).toEqual(['functions.exec']);
  });

  it('limits the clock exception to the built-in clock and still rejects unknown nested tools', () => {
    const request = {
      input: [],
      tools: [
        { type: 'function', namespace: 'clock', name: 'curr_time' },
        { type: 'function', namespace: 'clock', name: 'sleep' },
        {
          type: 'custom',
          namespace: 'functions',
          name: 'exec',
          description: '### `clock__curr_time`\n### `exec_command`',
        },
        { type: 'function', namespace: 'functions', name: 'wait' },
      ],
    };
    expect(forbiddenTools(request)).toEqual([
      'clock.sleep',
      'functions.exec',
      'functions.exec/exec_command',
      'functions.wait',
    ]);
    const receipt = [{ output: 'code-mode host is disabled' }];
    expect(forbiddenTools(request, { exec: receipt, wait: receipt })).toEqual([
      'clock.sleep',
      'functions.exec/exec_command',
    ]);
    expect(forbiddenTools(request, { exec: [{ output: 'bad arguments' }], wait: [] })).toContain(
      'functions.exec',
    );
  });

  it('requires an exact current clock value, not arbitrary output or missing evidence', () => {
    const now = Date.parse('2026-09-28T10:00:00Z');
    expect(allowedClockCall([{ output: 'It is 2026-09-28 10:00:00 UTC.' }], now, now)).toBe(true);
    for (const output of [
      'It is 2020-01-01 00:00:00 UTC.',
      'It is 2026-09-28 10:00:00 UTC.\nsecret',
      'Clock read failed',
      {},
    ]) {
      expect(allowedClockCall([{ output }], now, now)).toBe(false);
    }
    expect(allowedClockCall([], now, now)).toBe(false);
  });

  it('allows user input without allowing tool execution or deferred discovery', () => {
    const request = {
      tools: [
        { type: 'function', name: 'request_user_input' },
        { type: 'function', name: 'request_user_input_async' },
        { type: 'tool_search' },
      ],
      input: [],
    };
    expect(forbiddenTools(request)).toEqual(['tool_search']);
    expect(declaredTools({ tools: [], input: [] })).toEqual([]);
  });

  it('requires the separate agents switch and preserves explicit namespaces', () => {
    expect(projectlessCandidateConfig['agents.enabled']).toBe(false);
    expect(
      forbiddenTools({
        input: [],
        tools: [{ type: 'function', namespace: 'unexpected', name: 'request_user_input' }],
      }),
    ).toEqual(['unexpected.request_user_input']);
  });

  it('requires a fresh empty-environments receipt rather than absent metadata', () => {
    expect(emptyTurnEnvironments({ thread: { environments: [] } })).toBe(true);
    for (const response of [
      {},
      { thread: {} },
      { thread: { environments: null } },
      { thread: { environments: [{ environmentId: 'local' }] } },
    ]) {
      expect(emptyTurnEnvironments(response)).toBe(false);
    }
  });

  it.each([
    {},
    { tools: {}, input: [] },
    { tools: [null], input: [] },
    { tools: [{}], input: [] },
    { tools: [{ type: 'unknown', name: 'request_user_input' }], input: [] },
    { tools: [{ type: 'function', name: 'request_user_input', namespace: {} }], input: [] },
    { input: [{ type: 'additional_tools' }] },
    { input: [{ type: 'additional_tools', tools: [{ type: 'namespace', tools: [] }] }] },
  ])('fails closed for unknown declaration shapes: %j', (request) => {
    expect(() => declaredTools(request)).toThrow();
  });

  it('matches the injected call ID and excludes model refusal messages', () => {
    const requests = [
      {
        input: [
          { type: 'message', content: [{ type: 'output_text', text: 'I cannot execute tools' }] },
          {
            type: 'function_call_output',
            call_id: 'previous',
            output: 'unsupported call: exec_command',
          },
          {
            type: 'function_call_output',
            call_id: 'target',
            output: '{"agents":[{"agent_name":"/root"}]}',
          },
        ],
      },
    ];
    expect(toolOutputs(requests, 'target')).toHaveLength(1);
    expect(rejectedToolCall(toolOutputs(requests, 'target'))).toBe(false);
    expect(rejectedToolCall(toolOutputs(requests, 'missing'))).toBe(false);
    expect(rejectedToolCall(toolOutputs(requests, 'previous'))).toBe(true);
    expect(returnedAgentList(toolOutputs(requests, 'target'))).toBe(true);
    expect(returnedAgentList([{ output: 'unsupported call: collaborationlist_agents' }])).toBe(
      false,
    );
    expect(returnedAgentList([{ output: 'null' }])).toBe(false);
  });

  it.each([
    'unsupported call: exec_command',
    'unsupported custom tool call: apply_patch',
    'code-mode host is disabled',
  ])('recognizes reviewed transport rejections: %s', (output) => {
    expect(rejectedToolCall([{ output }])).toBe(true);
  });

  it.each([
    '',
    'Command exited with code 1',
    'bad arguments',
    'I refuse to use tools',
    'Success: unsupported call: exec_command',
    { error: 'unknown' },
  ])(
    'does not treat execution failures or arbitrary output as an enforced rejection: %j',
    (output) => {
      expect(rejectedToolCall([{ output }])).toBe(false);
    },
  );

  it('keeps sandbox hints but never passes host IPC bindings or credentials to the fixture', () => {
    expect(
      projectlessProbeEnvironment({
        HOME: '/fixture',
        PATH: '/usr/bin',
        USER: 'fixture',
        CODEX_HOME: '/real',
        CODEX_SANDBOX: 'seatbelt',
        CODEX_SANDBOX_NETWORK_DISABLED: '1',
        CODEX_APP_TOOLS_PIPE_PATH: '/real/socket',
        CODEX_THREAD_ID: 'real-thread',
        CODEX_PERMISSION_PROFILE: 'inherited',
        OPENAI_API_KEY: 'never-pass',
        FEISHU_SECRET: 'never-pass',
        GITHUB_TOKEN: 'never-pass',
      }),
    ).toEqual({
      HOME: '/fixture',
      PATH: '/usr/bin',
      USER: 'fixture',
      CODEX_SANDBOX: 'seatbelt',
      CODEX_SANDBOX_NETWORK_DISABLED: '1',
    });
  });
});

describe('NP0 loopback model fixture', () => {
  const post = (provider, body, headers = {}) =>
    fetch(`${provider.url}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });

  it.each([0, 257, 1.5, NaN, Infinity])(
    'rejects an invalid request budget: %s',
    async (maxRequests) => {
      await expect(projectlessProvider({ maxRequests })).rejects.toThrow(
        'Invalid fixture request limit',
      );
    },
  );

  it('enforces the configured request budget for expanded recovery probes', async () => {
    const provider = await projectlessProvider({ maxRequests: 1 });
    try {
      const response = await post(provider, { input: [] });
      expect(response.status).toBe(200);
      await response.text();
      expect((await post(provider, { input: [] })).status).toBe(400);
      expect(provider.requests).toHaveLength(1);
    } finally {
      await provider.close();
    }
  });

  it('streams Responses events and captures bodies without retaining authorization headers', async () => {
    const provider = await projectlessProvider();
    try {
      expect(new URL(provider.url).hostname).toBe('127.0.0.1');
      const response = await post(
        provider,
        { input: [] },
        { authorization: 'Bearer fixture-secret' },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      const events = (await response.text())
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.slice(6)));
      expect(events.at(-1).type).toBe('response.completed');
      expect(events.at(-1).response.output[0].content[0].text).toBe('NP0_FIXTURE_OK');
      expect(provider.requests).toEqual([{ input: [] }]);
      expect(JSON.stringify(provider.requests)).not.toContain('fixture-secret');
    } finally {
      await provider.close();
      await provider.close();
    }
  });

  it('can inject a real protocol call before completing the following model request', async () => {
    const item = {
      type: 'function_call',
      id: 'fc_fixture',
      call_id: 'fixture',
      namespace: 'collaboration',
      name: 'list_agents',
      arguments: '{}',
    };
    const provider = await projectlessProvider({
      respond: (_body, index) => (index === 0 ? { item } : { text: 'DONE' }),
    });
    try {
      const first = await post(provider, { input: [] });
      expect(await first.text()).toContain('"type":"function_call"');
      const second = await post(provider, {
        input: [
          {
            type: 'function_call_output',
            call_id: 'fixture',
            output: 'unsupported call: list_agents',
          },
        ],
      });
      expect(await second.text()).toContain('DONE');
      expect(provider.errors).toEqual([]);
    } finally {
      await provider.close();
    }
  });

  it('rejects unrelated endpoints, malformed JSON and an unbounded model loop', async () => {
    const provider = await projectlessProvider();
    try {
      expect((await fetch(`${provider.url}/other`)).status).toBe(404);
      expect(
        (
          await fetch(`${provider.url}/responses`, {
            method: 'POST',
            body: 'invalid-fixture-secret',
          })
        ).status,
      ).toBe(400);
      expect(provider.errors).toEqual(['Invalid JSON']);
      for (let i = 0; i < 30; i++) {
        const response = await post(provider, { input: [] });
        expect(response.status).toBe(200);
        await response.text();
      }
      expect((await post(provider, { input: [] })).status).toBe(400);
      expect(provider.requests).toHaveLength(30);
      expect(JSON.stringify(provider.errors)).not.toContain('fixture-secret');
    } finally {
      await provider.close();
    }
  });
});

it('binds the enabled ordinary-chat policy to its reviewed NP0 digest', () => {
  expect(attestedPolicyMatches()).toBe(true);
});
