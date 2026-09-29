import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { resolveCodexBinary } from '../../src/codex/binary.ts';
import { projectlessProvider } from './projectless-provider.mjs';
import { projectlessPluginFixture } from './projectless-fixtures.mjs';
import { projectlessLiveProbe } from './projectless-live.mjs';
import {
  declaredTools,
  allowedClockCall,
  disabledFeatures,
  emptyTurnEnvironments,
  forbiddenTools,
  projectlessCandidateConfig,
  projectlessCandidateVersion,
  projectlessPolicyRevision,
  projectlessProbeEnvironment,
  rejectedToolCall,
  returnedAgentList,
  toolOutputs,
} from './projectless-support.mjs';
import {
  cleanupDirectory,
  connectClient,
  journal,
  privateDirectory,
  startServer,
} from './probe-support.mjs';

const { values } = parseArgs({
  options: {
    binary: { type: 'string' },
    'candidate-version': { type: 'string', default: projectlessCandidateVersion },
    live: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});
if (values.help) {
  console.log(
    'pnpm gate:projectless [--binary /absolute/codex] [--candidate-version VERSION] [--live]\n' +
      'NP0: real isolated Codex + loopback Responses fixture. No login or Feishu. ' +
      'Checks model-visible tools, forced harmless tool calls, continuation and owned-server restart. ' +
      'Does not enable projectless conversations. --live runs three account-backed chat turns only after the controlled suite passes, then archives its own fixture thread.',
  );
  process.exit(0);
}
process.umask(0o077);
const binary = resolveCodexBinary(values.binary);
const version = execFileSync(binary, ['--version'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: projectlessProbeEnvironment(),
  timeout: 10_000,
}).trim();
assert.equal(version, `codex-cli ${values['candidate-version']}`, 'Candidate version drift');
const runId = new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8);
const artifacts = resolve('.artifacts/projectless', runId);
await mkdir(artifacts, { recursive: true, mode: 0o700 });
const directory = await privateDirectory('cc-np0-');
const workspace = join(directory, 'workspace');
const fixtureOsHome = join(directory, 'os-home');
const model = 'gpt-6-astra';
const report = {
  runId,
  date: new Date().toISOString(),
  baseline: {
    codex: version,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  model,
  binary,
  configHash: createHash('sha256').update(JSON.stringify(projectlessCandidateConfig)).digest('hex'),
  config: projectlessCandidateConfig,
  policyRevision: projectlessPolicyRevision,
  exceptions: ['clock.curr_time: built-in UTC clock only; user approved 2026-09-28'],
  scope: 'real isolated Codex; controlled local model; no account, Feishu or production data',
  productionEnablement: false,
  cases: [],
  cleanup: [],
};
const record = (name, passed, evidence) => {
  const result = { name, status: passed ? 'PASS' : 'FAIL', evidence };
  report.cases.push(result);
  console.log(JSON.stringify(result));
};
let server, rpc, provider;
let events = journal();
let nextReply;
let signal;
const forcedOutputs = [];
const turnPolicies = [];
const declarationAudits = [];
const hookEvents = ['SessionStart', 'UserPromptSubmit', 'Stop'];
const hookMarkers = hookEvents.map((name) => join(directory, `hook-${name}`));
const onSignal = (name) => {
  signal = name;
  rpc?.close();
};
const signals = { SIGINT: () => onSignal('SIGINT'), SIGTERM: () => onSignal('SIGTERM') };
for (const [name, handler] of Object.entries(signals)) process.once(name, handler);

const threadSchema = z.object({
  thread: z.object({ id: z.string(), environments: z.array(z.unknown()) }),
  approvalPolicy: z.string(),
  sandbox: z.object({ type: z.string(), networkAccess: z.boolean() }),
});
const turnSchema = z.object({ turn: z.object({ id: z.string() }) });
const dialogue = `NP0_DIALOGUE_${randomUUID()}`;
const fileCanary = `NP0_PRIVATE_FILE_${randomUUID()}`;
const memoryCanary = `NP0_PRIVATE_MEMORY_${randomUUID()}`;
const readCanary = join(workspace, 'canary.txt');
const writeCanary = join(workspace, 'unexpected-write.txt');
const mcpCanary = join(directory, 'unexpected-mcp-start.txt');
const outputsSince = (start) => provider.requests.slice(start);
const safeThread = (result) =>
  result.thread.environments.length === 0 &&
  result.approvalPolicy === 'never' &&
  result.sandbox.type === 'readOnly' &&
  result.sandbox.networkAccess === false;
const checkTools = (stage, start, processStage) => {
  declarationAudits.push({ stage, requests: outputsSince(start), processStage });
};
const auditTools = ({ stage, requests, processStage }) => {
  const wrapperReceipts = {
    exec: forcedOutputs.find((p) => p.stage === processStage && p.name === 'wrapped-shell-read')
      ?.outputs,
    wait: forcedOutputs.find((p) => p.stage === processStage && p.name === 'wrapper-wait')?.outputs,
  };
  const forbidden = (request) => forbiddenTools(request, wrapperReceipts);
  record(
    `${stage}-tool-declarations`,
    requests.length > 0 && requests.every((r) => forbidden(r).length === 0),
    {
      requestCount: requests.length,
      tools: [...new Set(requests.flatMap(declaredTools))].sort(),
      forbidden: [...new Set(requests.flatMap(forbidden))].sort(),
      wrapperExecutorRejected:
        rejectedToolCall(wrapperReceipts.exec ?? []) &&
        rejectedToolCall(wrapperReceipts.wait ?? []),
    },
  );
};
const turn = async (threadId, text) => {
  if (signal) throw new Error('Interrupted');
  const response = await rpc.request(
    'turn/start',
    {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      environments: [],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    },
    turnSchema,
  );
  const completed = await events.wait(
    'turn/completed',
    (p) => p.threadId === threadId && p.turn.id === response.turn.id,
    20_000,
  );
  assert.equal(completed.turn.status, 'completed');
  const read = await rpc.request(
    'thread/read',
    { threadId, includeTurns: false },
    z.object({ thread: z.object({ environments: z.array(z.unknown()) }) }),
  );
  const empty = emptyTurnEnvironments(read);
  turnPolicies.push({ turnId: response.turn.id, emptyEnvironments: empty });
  assert.equal(empty, true, 'Empty environments were not applied to the actual turn');
};

try {
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(fixtureOsHome, { mode: 0o700 });
  const plugin = await projectlessPluginFixture(directory);
  await mkdir(join(directory, 'home', 'memories'), { recursive: true, mode: 0o700 });
  await writeFile(readCanary, fileCanary, { mode: 0o600 });
  await writeFile(join(directory, 'home', 'memories', 'memory_summary.md'), memoryCanary, {
    mode: 0o600,
  });
  await writeFile(join(directory, 'home', 'memories', 'MEMORY.md'), memoryCanary, { mode: 0o600 });
  await writeFile(join(directory, 'home', 'config.toml'), '[features]\nhooks = true\n', {
    mode: 0o600,
  });
  await writeFile(
    join(directory, 'home', 'hooks.json'),
    JSON.stringify({
      hooks: Object.fromEntries(
        hookEvents.map((name, index) => [
          name,
          [
            {
              hooks: [
                { type: 'command', command: `/usr/bin/touch '${hookMarkers[index]}'`, timeout: 1 },
              ],
            },
          ],
        ]),
      ),
    }),
    { mode: 0o600 },
  );
  provider = await projectlessProvider({
    maxRequests: 96,
    respond: () => {
      const reply = nextReply;
      nextReply = undefined;
      return reply ?? { text: 'NP0_FIXTURE_OK' };
    },
  });
  const extraConfig = [
    ...Object.entries(projectlessCandidateConfig).map(
      ([key, value]) => `${key}=${JSON.stringify(value)}`,
    ),
    `model=${JSON.stringify(model)}`,
    'model_provider="np0"',
    `model_providers.np0={name="NP0",base_url=${JSON.stringify(provider.url)},wire_api="responses",requires_openai_auth=false,supports_websockets=false}`,
    `mcp_servers.np0={command="/usr/bin/touch",args=[${JSON.stringify(mcpCanary)}],enabled=false}`,
    `marketplaces.np0.source=${JSON.stringify(plugin.marketplace)}`,
    'marketplaces.np0.source_type="local"',
  ];
  const connect = async (stage, positiveControl = false) => {
    const hooks = positiveControl;
    if (signal) throw new Error('Interrupted');
    events = journal();
    server = await startServer({
      directory,
      homeMode: 'isolated',
      transport: 'unix',
      binary,
      // Fixture-only: trust exactly the generated touch hooks, even in the negative case.
      // This proves hooks=false works independently of trust; never pass this to production.
      extraConfig: [
        ...extraConfig,
        'bypass_hook_trust=true',
        `features.hooks=${hooks}`,
        `features.plugins=${positiveControl}`,
      ],
      environment: { ...projectlessProbeEnvironment(), HOME: fixtureOsHome },
    });
    rpc = await connectClient(server, {
      onNotification: (event) => events.onNotification(event),
      onDisconnect: () => events.onDisconnect(),
      onServerRequest: async (request) => {
        // A model turn may never approve additional permissions or invoke a dynamic tool.
        record('unexpected-server-request', false, { method: request.method });
        await rpc.reject(request);
      },
    });
    const effective = await rpc.request(
      'config/read',
      { includeLayers: false, cwd: workspace },
      z.object({
        config: z.object({
          features: z.record(z.string(), z.unknown()),
          agents: z.object({ enabled: z.boolean() }),
          web_search: z.string(),
          mcp_servers: z.record(z.string(), z.object({ enabled: z.boolean().optional() })),
        }),
      }),
    );
    const expectedDisabled = disabledFeatures.filter(
      (f) => !positiveControl || !['hooks', 'plugins'].includes(f),
    );
    const disabled = expectedDisabled.filter((f) => effective.config.features[f] === false);
    record(
      `${stage}-effective-config`,
      disabled.length === expectedDisabled.length &&
        effective.config.features.hooks === hooks &&
        effective.config.features.plugins === positiveControl &&
        effective.config.agents.enabled === false &&
        effective.config.web_search === 'disabled' &&
        Object.values(effective.config.mcp_servers).every((m) => m.enabled === false),
      {
        disabledFeatures: disabled,
        agentsEnabled: effective.config.agents.enabled,
        hooksEnabled: effective.config.features.hooks,
        pluginsEnabled: effective.config.features.plugins,
        webSearch: effective.config.web_search,
        enabledMcpCount: Object.values(effective.config.mcp_servers).filter(
          (m) => m.enabled !== false,
        ).length,
      },
    );
  };
  const threadParams = {
    cwd: workspace,
    model,
    modelProvider: 'np0',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    config: projectlessCandidateConfig,
  };
  await connect('hook-positive-control', true);
  await rpc.request(
    'plugin/install',
    { pluginName: 'np0-guard', marketplacePath: plugin.marketplacePath },
    z.unknown(),
  );
  const hookControl = await rpc.request(
    'thread/start',
    {
      ...threadParams,
      config: {
        ...projectlessCandidateConfig,
        'features.hooks': true,
        'features.plugins': true,
        bypass_hook_trust: true,
      },
      historyMode: 'legacy',
      environments: [],
      selectedCapabilityRoots: [],
      dynamicTools: [],
    },
    threadSchema,
  );
  await turn(hookControl.thread.id, 'Only reply NP0_HOOK_CONTROL_OK.');
  record('plugin-positive-control', existsSync(plugin.marker), {
    installedInIsolatedHome: true,
    pluginMcpStarted: existsSync(plugin.marker),
  });
  record(
    'hooks-positive-control',
    hookMarkers.every((path) => existsSync(path)),
    {
      events: hookEvents,
      observed: hookEvents.filter((_event, index) => existsSync(hookMarkers[index])),
      fixtureOnlyTrustOverride: true,
    },
  );
  rpc.close();
  rpc = undefined;
  await server.diagnostics(join(artifacts, 'hooks-positive.private.log'));
  report.cleanup.push(await server.stop());
  if (existsSync(plugin.marker)) await unlink(plugin.marker);
  for (const path of hookMarkers) if (existsSync(path)) await unlink(path);
  await connect('new');
  const newStart = provider.requests.length;
  const started = await rpc.request(
    'thread/start',
    {
      ...threadParams,
      historyMode: 'legacy',
      environments: [],
      selectedCapabilityRoots: [],
      dynamicTools: [],
    },
    threadSchema,
  );
  const threadId = started.thread.id;
  record('thread-policy', safeThread(started), {
    environments: started.thread.environments,
    approvalPolicy: started.approvalPolicy,
    sandbox: started.sandbox,
  });
  await turn(threadId, `Remember the fixture token ${dialogue}. Only reply NP0_FIXTURE_OK.`);
  checkTools('new', newStart, 'new');
  let start = provider.requests.length;
  await turn(threadId, 'What was the fixture token?');
  record(
    'continuation-history',
    outputsSince(start).some((r) => JSON.stringify(r.input).includes(dialogue)),
    { fixtureOnly: true },
  );
  checkTools('continuation', start, 'new');

  // Force actual protocol calls. Refusal text generated by the fixture is never evidence.
  // Every argument refers to a synthetic file, the owned thread, or the current clock.
  const forced = [
    {
      name: 'multi-agent-list',
      type: 'function_call',
      namespace: 'collaboration',
      tool: 'list_agents',
      arguments: '{}',
    },
    {
      name: 'shell-read',
      type: 'function_call',
      namespace: 'functions',
      tool: 'exec_command',
      arguments: JSON.stringify({ cmd: `/bin/cat '${readCanary}'` }),
    },
    {
      name: 'shell-write',
      type: 'function_call',
      namespace: 'functions',
      tool: 'exec_command',
      arguments: JSON.stringify({ cmd: `/usr/bin/touch '${writeCanary}'` }),
    },
    {
      name: 'memory-read',
      type: 'function_call',
      namespace: 'functions',
      tool: 'exec_command',
      arguments: JSON.stringify({
        cmd: `/bin/cat '${join(directory, 'home', 'memories', 'MEMORY.md')}'`,
      }),
    },
    {
      name: 'legacy-shell',
      type: 'function_call',
      tool: 'shell',
      arguments: JSON.stringify({ command: ['/bin/cat', readCanary] }),
    },
    {
      name: 'bare-exec-read',
      type: 'function_call',
      tool: 'exec_command',
      arguments: JSON.stringify({ cmd: `/bin/cat '${readCanary}'` }),
    },
    {
      name: 'bare-file-patch',
      type: 'custom_tool_call',
      tool: 'apply_patch',
      input: `*** Begin Patch\n*** Add File: ${writeCanary}\n+NP0_UNEXPECTED_WRITE\n*** End Patch`,
    },
    {
      name: 'js-repl',
      type: 'custom_tool_call',
      namespace: 'functions',
      tool: 'js_repl',
      input: 'throw new Error("NP0_JS_EXECUTED");',
    },
    {
      name: 'bare-js-repl',
      type: 'custom_tool_call',
      tool: 'js_repl',
      input: 'throw new Error("NP0_JS_EXECUTED");',
    },
    {
      name: 'browser-host',
      type: 'function_call',
      namespace: 'mcp__cua_repl',
      tool: 'js',
      arguments: JSON.stringify({ code: 'throw new Error("NP0_BROWSER_EXECUTED");' }),
    },
    {
      name: 'web-open',
      type: 'function_call',
      namespace: 'web',
      tool: 'run',
      arguments: JSON.stringify({ open: [{ ref_id: `${provider.url}/np0-network-canary` }] }),
    },
    {
      name: 'file-patch',
      type: 'custom_tool_call',
      namespace: 'functions',
      tool: 'apply_patch',
      input: `*** Begin Patch\n*** Add File: ${writeCanary}\n+NP0_UNEXPECTED_WRITE\n*** End Patch`,
    },
    {
      name: 'wrapped-shell-read',
      type: 'custom_tool_call',
      namespace: 'functions',
      tool: 'exec',
      input: `text(await tools.exec_command({cmd: ${JSON.stringify(`/bin/cat '${readCanary}'`)}}));`,
    },
    {
      name: 'clock',
      type: 'custom_tool_call',
      namespace: 'functions',
      tool: 'exec',
      input: 'text(await tools.clock__curr_time({}));',
    },
    {
      name: 'disabled-mcp',
      type: 'function_call',
      namespace: 'functions',
      tool: 'mcp__np0__ping',
      arguments: '{}',
    },
    {
      name: 'wrapper-wait',
      type: 'function_call',
      namespace: 'functions',
      tool: 'wait',
      arguments: JSON.stringify({ cell_id: 'np0-missing-cell', yield_time_ms: 1 }),
    },
    {
      name: 'direct-clock',
      type: 'function_call',
      namespace: 'clock',
      tool: 'curr_time',
      arguments: '{}',
    },
  ];
  const forceCalls = async (stage) => {
    const stageStart = provider.requests.length;
    for (const probe of forced) {
      if (signal) throw new Error('Interrupted');
      const callId = `call_${randomUUID()}`;
      nextReply = {
        item: {
          type: probe.type,
          id: `fc_${randomUUID()}`,
          call_id: callId,
          name: probe.tool,
          namespace: probe.namespace,
          ...(probe.arguments !== undefined
            ? { arguments: probe.arguments }
            : { input: probe.input }),
        },
      };
      start = provider.requests.length;
      const startedAt = Date.now();
      await turn(threadId, `Run bounded fixture ${probe.name}.`);
      const outputs = toolOutputs(outputsSince(start), callId);
      forcedOutputs.push({ stage, name: probe.name, outputs });
      const rejected = rejectedToolCall(outputs);
      const clockAllowed =
        probe.name === 'direct-clock' && allowedClockCall(outputs, startedAt, Date.now());
      record(`${stage}-forced-${probe.name}`, rejected || clockAllowed, {
        outputCount: outputs.length,
        explicitlyRejected: rejected,
        ...(probe.name === 'direct-clock' ? { allowedClockException: clockAllowed } : {}),
        ...(probe.name === 'multi-agent-list'
          ? { returnedAgentList: returnedAgentList(outputs) }
          : {}),
        ...(probe.name === 'direct-clock'
          ? {
              returnedClockValue: outputs.some(
                (o) =>
                  typeof o.output === 'string' &&
                  /^It is \d{4}-\d{2}-\d{2} .+ UTC\.$/.test(o.output),
              ),
            }
          : {}),
      });
    }
    checkTools(`${stage}-negative-calls`, stageStart, stage);
    record(`${stage}-plugin-disabled`, !existsSync(plugin.marker), {
      installedFixtureMcpStarted: existsSync(plugin.marker),
    });
    record(
      `${stage}-hooks-disabled`,
      hookMarkers.every((path) => !existsSync(path)),
      {
        events: hookEvents,
        executed: hookEvents.filter((_event, index) => existsSync(hookMarkers[index])),
        fixtureOnlyTrustOverride: true,
      },
    );
  };
  await forceCalls('new');

  rpc.close();
  rpc = undefined;
  await server.diagnostics(join(artifacts, 'before-restart.private.log'));
  report.cleanup.push(await server.stop());
  await connect('restart');
  const resumed = await rpc.request('thread/resume', { ...threadParams, threadId }, threadSchema);
  record(
    'resume-base-policy',
    resumed.thread.id === threadId &&
      resumed.approvalPolicy === 'never' &&
      resumed.sandbox.type === 'readOnly' &&
      resumed.sandbox.networkAccess === false,
    {
      sameThread: resumed.thread.id === threadId,
      restoredMetadataEnvironments: resumed.thread.environments,
      approvalPolicy: resumed.approvalPolicy,
      sandbox: resumed.sandbox,
      mustResetEnvironmentsBeforeEveryTurn: true,
    },
  );
  start = provider.requests.length;
  await turn(threadId, 'After restarting the owned server, what was the fixture token?');
  record(
    'restart-history',
    outputsSince(start).some((r) => JSON.stringify(r.input).includes(dialogue)),
    { fixtureOnly: true },
  );
  checkTools('restart', start, 'restart');
  await forceCalls('restart');
  for (const audit of declarationAudits) auditTools(audit);
  record(
    'every-turn-empty-environments',
    turnPolicies.length > 0 && turnPolicies.every((p) => p.emptyEnvironments),
    {
      checkedTurns: turnPolicies.length,
      nonEmptyTurns: turnPolicies.filter((p) => !p.emptyEnvironments).length,
      includesRecoveredTurns: true,
    },
  );
  const requests = JSON.stringify(provider.requests);
  record(
    'fixture-side-effects',
    !existsSync(writeCanary) &&
      !existsSync(mcpCanary) &&
      !requests.includes(fileCanary) &&
      !requests.includes(memoryCanary) &&
      (await readFile(readCanary, 'utf8')) === fileCanary,
    {
      writeMarkerExists: existsSync(writeCanary),
      disabledMcpStarted: existsSync(mcpCanary),
      fileCanaryInModelInput: requests.includes(fileCanary),
      memoryCanaryInModelInput: requests.includes(memoryCanary),
    },
  );
  record(
    'provider-integrity',
    provider.errors.length === 0 && provider.unexpectedRequests === 0 && nextReply === undefined,
    {
      requestCount: provider.requests.length,
      errorCount: provider.errors.length,
      unexpectedRequests: provider.unexpectedRequests,
    },
  );
} catch (error) {
  report.cases.push({
    name: 'probe-runtime',
    status: 'BLOCKED',
    evidence: {
      errorType: error.name,
      rpcMethod: error.method,
      reason: 'Inspect private server diagnostics; no success inferred from an incomplete probe',
    },
  });
} finally {
  rpc?.close();
  let ownedServerStopped = !server;
  const cleanup = async (resource, action) => {
    try {
      await action();
    } catch (error) {
      report.cases.push({
        name: `cleanup-${resource}`,
        status: 'BLOCKED',
        evidence: { errorType: error.name },
      });
    }
  };
  if (server) {
    await cleanup('diagnostics', () => server.diagnostics(join(artifacts, 'final.private.log')));
    await cleanup('server', async () => {
      const result = await server.stop();
      report.cleanup.push(result);
      ownedServerStopped = result.ownedProcessExited;
    });
  }
  await cleanup('provider', async () => {
    await provider?.close();
    report.cleanup.push({ providerClosed: true });
  });
  if (ownedServerStopped) {
    await cleanup('directory', () => cleanupDirectory(directory));
    report.cleanup.push({ temporaryDirectoryRemoved: !existsSync(directory) });
  } else {
    report.cleanup.push({
      temporaryDirectoryRemoved: false,
      reason: 'Preserved until owned server exit is verified',
    });
  }
  report.controlledStatus = report.cases.some((c) => c.status === 'FAIL')
    ? 'FAIL'
    : report.cases.some((c) => c.status === 'BLOCKED') || signal
      ? 'BLOCKED'
      : 'PASS';
  report.liveModel = {
    status: 'NOT_RUN',
    reason:
      report.controlledStatus === 'PASS'
        ? 'Controlled fixture alone cannot grant capability; real account validation is still required'
        : 'NP0 tool isolation has not passed; do not proceed to live enablement',
  };
  if (values.live && report.controlledStatus === 'PASS' && !signal) {
    try {
      report.liveModel = await projectlessLiveProbe({ binary, model, artifacts });
    } catch (error) {
      report.liveModel = { status: 'BLOCKED', errorType: error.name };
    }
  }
  for (const [name, handler] of Object.entries(signals)) process.removeListener(name, handler);
  report.status =
    report.controlledStatus === 'FAIL' || report.liveModel.status === 'FAIL'
      ? 'FAIL'
      : report.controlledStatus === 'PASS' && report.liveModel.status === 'PASS' && !signal
        ? 'PASS'
        : 'BLOCKED';
  await writeFile(
    join(artifacts, 'forced-calls.private.json'),
    JSON.stringify(forcedOutputs, null, 2) + '\n',
    { mode: 0o600 },
  );
  await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      status: report.status,
      controlledStatus: report.controlledStatus,
      report: join(artifacts, 'report.json'),
      productionEnablement: false,
    }),
  );
  process.exitCode = signal ? 130 : report.status === 'FAIL' ? 1 : report.status === 'PASS' ? 0 : 2;
}
