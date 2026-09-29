import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  cleanupDirectory,
  connectClient,
  journal,
  privateDirectory,
  startServer,
} from './probe-support.mjs';
import {
  disabledFeatures,
  emptyTurnEnvironments,
  projectlessCandidateConfig,
  projectlessProbeEnvironment,
} from './projectless-support.mjs';

/** Uses Codex's own login handling. Never reads/copies credentials or changes global config. */
export async function projectlessLiveProbe({ binary, model, artifacts }) {
  const directory = await privateDirectory('cc-np0-live-');
  const workspace = join(directory, 'workspace');
  const cases = [],
    cleanup = [];
  let server, rpc, threadId, activeTurn;
  let events = journal();
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    rpc?.close();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const record = (name, passed, evidence) => {
    const result = { name, status: passed ? 'PASS' : 'FAIL', evidence };
    cases.push(result);
    console.log(JSON.stringify({ ...result, name: `live-${name}` }));
  };
  const config = { ...projectlessCandidateConfig, model_reasoning_effort: 'low' };
  const extraConfig = Object.entries(config).map(
    ([key, value]) => `${key}=${JSON.stringify(value)}`,
  );
  const schema = z.object({
    config: z.object({
      features: z.record(z.string(), z.unknown()),
      agents: z.object({ enabled: z.boolean() }),
      web_search: z.string(),
      mcp_servers: z.record(z.string(), z.object({ enabled: z.boolean().optional() })).default({}),
    }),
  });
  const threadSchema = z.object({
    thread: z.object({ id: z.string(), environments: z.array(z.unknown()) }),
    approvalPolicy: z.string(),
    sandbox: z.object({ type: z.string(), networkAccess: z.boolean() }),
  });
  const connect = async () => {
    assert.equal(interrupted, false);
    events = journal();
    server = await startServer({
      directory,
      homeMode: 'existing',
      transport: 'unix',
      binary,
      extraConfig,
      environment: projectlessProbeEnvironment(),
    });
    rpc = await connectClient(server, {
      onNotification: (event) => events.onNotification(event),
      onDisconnect: () => events.onDisconnect(),
      onServerRequest: async (request) => {
        record('unexpected-server-request', false, { method: request.method });
        await rpc.reject(request);
      },
    });
    return (await rpc.request('config/read', { cwd: workspace, includeLayers: false }, schema))
      .config;
  };
  const stop = async (stage) => {
    rpc?.close();
    rpc = undefined;
    if (server) {
      try {
        await server.diagnostics(join(artifacts, `live-${stage}.private.log`));
      } finally {
        cleanup.push(await server.stop());
        server = undefined;
      }
    }
  };
  const checkConfig = (stage, effective) => {
    const passed =
      disabledFeatures.every((f) => effective.features[f] === false) &&
      effective.agents.enabled === false &&
      effective.web_search === 'disabled' &&
      Object.values(effective.mcp_servers).every((m) => m.enabled === false);
    record(`${stage}-effective-policy`, passed, {
      disabledFeatureCount: disabledFeatures.filter((f) => effective.features[f] === false).length,
      enabledMcpCount: Object.values(effective.mcp_servers).filter((m) => m.enabled !== false)
        .length,
      agentsEnabled: effective.agents.enabled,
    });
    assert.equal(passed, true);
  };
  const startTurn = async (stage, text, expected) => {
    assert.equal(interrupted, false);
    const response = await rpc.request(
      'turn/start',
      {
        threadId,
        input: [{ type: 'text', text, text_elements: [] }],
        environments: [],
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      },
      z.object({ turn: z.object({ id: z.string() }) }),
    );
    activeTurn = response.turn.id;
    const completed = await events.wait(
      'turn/completed',
      (p) => p.threadId === threadId && p.turn.id === activeTurn,
      120_000,
    );
    assert.equal(completed.turn.status, 'completed');
    const turnId = activeTurn;
    activeTurn = undefined;
    const read = await rpc.request(
      'thread/read',
      { threadId, includeTurns: false },
      z.object({ thread: z.object({ environments: z.array(z.unknown()) }) }),
    );
    assert.equal(emptyTurnEnvironments(read), true);
    const items = new Map((completed.turn.items ?? []).map((item) => [item.id, item]));
    for (const event of events.entries)
      if (
        event.method === 'item/completed' &&
        event.params.threadId === threadId &&
        event.params.turnId === turnId
      )
        items.set(event.params.item.id, event.params.item);
    const output = [...items.values()]
      .filter((item) => item.type === 'agentMessage')
      .map((item) => item.text)
      .join('\n')
      .trim();
    const types = [...new Set([...items.values()].map((item) => item.type))];
    const noUnexpectedTools = types.every((type) =>
      ['userMessage', 'agentMessage', 'reasoning'].includes(type),
    );
    record(stage, output === expected && noUnexpectedTools, {
      answerMatched: output === expected,
      itemTypes: types,
      emptyEnvironments: true,
      turnId,
    });
    assert.equal(output, expected);
    assert.equal(noUnexpectedTools, true);
  };
  try {
    await mkdir(workspace, { mode: 0o700 });
    const discovered = await connect();
    const names = Object.keys(discovered.mcp_servers);
    if (names.some((name) => !/^[A-Za-z0-9_-]+$/.test(name)))
      throw new Error('Unrepresentable MCP key');
    for (const name of names) {
      config[`mcp_servers.${name}.enabled`] = false;
      extraConfig.push(`mcp_servers.${name}.enabled=false`);
    }
    // Disable discovered skills in this owned process, without changing the user's files.
    const skills = await rpc.request(
      'skills/list',
      { cwds: [workspace], forceReload: true },
      z.object({
        data: z.array(
          z.object({ skills: z.array(z.object({ path: z.string(), enabled: z.boolean() })) }),
        ),
      }),
    );
    const paths = [
      ...new Set(skills.data.flatMap((entry) => entry.skills.map((skill) => skill.path))),
    ];
    config['skills.config'] = paths.map((path) => ({ path, enabled: false }));
    extraConfig.push(
      `skills.config=[${paths.map((path) => `{path=${JSON.stringify(path)},enabled=false}`).join(',')}]`,
    );
    record('local-discovery', true, {
      mcpCount: names.length,
      skillsCount: paths.length,
      credentialsCopied: false,
    });
    await stop('discovery');
    checkConfig('new', await connect());
    const disabledSkills = await rpc.request(
      'skills/list',
      { cwds: [workspace], forceReload: true },
      z.object({
        data: z.array(z.object({ skills: z.array(z.object({ enabled: z.boolean() })) })),
      }),
    );
    assert.equal(
      disabledSkills.data.flatMap((entry) => entry.skills).some((skill) => skill.enabled),
      false,
    );
    const account = await rpc.request(
      'account/read',
      { refreshToken: false },
      z.object({ account: z.object({ type: z.string() }).nullable() }),
    );
    assert.notEqual(account.account, null, 'Codex login required');
    const params = { cwd: workspace, model, approvalPolicy: 'never', sandbox: 'read-only', config };
    const started = await rpc.request(
      'thread/start',
      {
        ...params,
        historyMode: 'legacy',
        environments: [],
        dynamicTools: [],
        selectedCapabilityRoots: [],
      },
      threadSchema,
    );
    threadId = started.thread.id;
    assert.equal(started.approvalPolicy, 'never');
    assert.deepEqual(started.sandbox, { type: 'readOnly', networkAccess: false });
    assert.equal(emptyTurnEnvironments(started), true);
    await rpc.request('thread/memoryMode/set', { threadId, mode: 'disabled' }, z.unknown());
    const token = `NP0_LIVE_${randomUUID().replaceAll('-', '')}`;
    await startTurn(
      'new-chat',
      `This is an isolated plain-chat acceptance test. Do not use tools, read files, or access memory. Remember this exact conversation token: ${token}. Reply only NP0_LIVE_READY.`,
      'NP0_LIVE_READY',
    );
    await startTurn(
      'continuation',
      'Without using tools or reading files, reply only with the exact conversation token I asked you to remember.',
      token,
    );
    await stop('before-restart');
    checkConfig('restart', await connect());
    const resumed = await rpc.request('thread/resume', { ...params, threadId }, threadSchema);
    assert.equal(resumed.thread.id, threadId);
    assert.equal(resumed.approvalPolicy, 'never');
    assert.deepEqual(resumed.sandbox, { type: 'readOnly', networkAccess: false });
    await rpc.request('thread/memoryMode/set', { threadId, mode: 'disabled' }, z.unknown());
    await startTurn(
      'restart-continuation',
      'Without using tools or reading files, reply only with the exact conversation token I asked you to remember at the beginning.',
      token,
    );
  } catch (error) {
    await writeFile(
      join(artifacts, 'live-error.private.json'),
      JSON.stringify({
        name: error.name,
        message: error.message,
        remoteMessage: error.remoteMessage,
      }),
      { mode: 0o600 },
    );
    cases.push({
      name: 'live-runtime',
      status: 'BLOCKED',
      evidence: {
        errorType: error.name,
        rpcMethod: error.method,
        reason: 'Inspect private diagnostics; no live success inferred',
      },
    });
  } finally {
    if (rpc?.isReady && threadId && !activeTurn) {
      try {
        await rpc.request('thread/archive', { threadId }, z.unknown());
        cleanup.push({ fixtureThreadArchived: true });
      } catch {
        cleanup.push({ fixtureThreadArchived: false });
      }
    }
    try {
      await stop('final');
    } catch (error) {
      cases.push({
        name: 'cleanup-server',
        status: 'BLOCKED',
        evidence: { errorType: error.name },
      });
    }
    if (!server) {
      await cleanupDirectory(directory);
      cleanup.push({ temporaryDirectoryRemoved: true });
    }
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
  return {
    status: cases.some((c) => c.status === 'FAIL')
      ? 'FAIL'
      : cases.some((c) => c.status === 'BLOCKED')
        ? 'BLOCKED'
        : 'PASS',
    cases,
    cleanup,
    threadId,
  };
}
