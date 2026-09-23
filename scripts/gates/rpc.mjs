import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { fixtureApprovalDecision } from './approval-fixture.mjs';
import { GATEWAY_THREAD_POLICY } from '../../src/codex/protocol.ts';
import { RpcRejectedError, RpcTransportError } from '../../src/codex/rpc-client.ts';
import {
  threadResultSchema,
  threadListSchema,
  turnResultSchema,
  turnsPageSchema,
  turnEventSchema,
  steerResultSchema,
  emptyResultSchema,
  commandApprovalSchema,
} from '../../src/codex/schemas.ts';
import {
  privateDirectory,
  startServer,
  connectClient,
  journal,
  versionBaseline,
  cleanupDirectory,
  ProbeBlocked,
  delay,
} from './probe-support.mjs';

const { values } = parseArgs({
  options: {
    home: { type: 'string', default: 'isolated' },
    transport: { type: 'string', default: 'both' },
    live: { type: 'boolean', default: false },
    suite: { type: 'string', default: 'all' },
    'candidate-version': { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});
if (values.help) {
  console.log(
    'pnpm gate:rpc [--home isolated|existing] [--transport both|ws|unix] [--live] [--suite all|completed|controls|approvals|recovery|rpc-controls]\nDefault: isolated Home, no model turns. --live uses existing login, creates test history, runs bounded model turns and only approves the exact harmless printf fixture. rpc-controls tests steer acceptance, reconnect, interrupt and pending cleanup without waiting for successful model generation. It never changes global config or deletes history.',
  );
  process.exit(0);
}
if (
  !['isolated', 'existing'].includes(values.home) ||
  !['both', 'ws', 'unix'].includes(values.transport) ||
  !['all', 'completed', 'controls', 'approvals', 'recovery', 'rpc-controls'].includes(values.suite)
)
  throw new Error('Invalid probe options');
if (values.live && values.home !== 'existing') throw new Error('--live requires --home existing');
process.umask(0o077);
const runId = new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8);
const artifacts = resolve('.artifacts/g2', runId);
await mkdir(artifacts, { recursive: true, mode: 0o700 });
const report = {
  runId,
  date: new Date().toISOString(),
  baseline: versionBaseline(values['candidate-version']),
  homeMode: values.home,
  live: values.live,
  cases: [],
  cleanup: [],
  scope: 'G2 probe; PASS cases do not imply full milestone PASS',
};
const liveTransports = values.transport === 'both' ? ['ws', 'unix'] : [values.transport];
let activeServer;
let activeDirectory;
let stopping = false;
async function stopOnSignal() {
  if (stopping) return;
  stopping = true;
  await activeServer?.stop();
  if (activeDirectory) await cleanupDirectory(activeDirectory);
  report.status = 'BLOCKED';
  report.cleanup.push({
    interruptedBySignal: true,
    ownedServerStopped: true,
    temporaryDirectoryRemoved: true,
  });
  await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  process.exit(130);
}
process.once('SIGINT', () => {
  stopOnSignal().catch(() => process.exit(130));
});
process.once('SIGTERM', () => {
  stopOnSignal().catch(() => process.exit(130));
});

async function record(transport, name, callback) {
  const start = Date.now();
  try {
    const evidence = await callback();
    report.cases.push({
      transport,
      name,
      status: 'PASS',
      durationMs: Date.now() - start,
      evidence,
    });
  } catch (error) {
    await writeFile(
      join(artifacts, `${transport}-${name}.private.json`),
      JSON.stringify(
        {
          name: error.name,
          message: error.message,
          remoteMessage: error.remoteMessage,
          stack: error.stack,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    report.cases.push({
      transport,
      name,
      status: error instanceof ProbeBlocked ? 'BLOCKED' : 'FAIL',
      durationMs: Date.now() - start,
      error:
        error instanceof RpcRejectedError
          ? { type: error.name, method: error.method, code: error.code }
          : {
              type: error.name,
              message:
                error instanceof RpcTransportError || error instanceof ProbeBlocked
                  ? error.message
                  : 'Probe assertion or runtime failure (inspect implementation)',
            },
    });
  }
  console.log(JSON.stringify(report.cases.at(-1)));
}

const input = (text) => [{ type: 'text', text, text_elements: [] }];
function summarizeTurn(turn) {
  return {
    status: turn.status,
    itemTypes: turn.items.map((item) => item.type),
    hasError: turn.error !== null,
  };
}
function finalText(turn) {
  return turn.items
    .filter((item) => item.type === 'agentMessage')
    .map((item) => item.text ?? '')
    .join('\n');
}
async function terminal(events, threadId, turnId) {
  const event = await events.wait(
    'turn/completed',
    (params) => params.threadId === threadId && params.turn?.id === turnId,
  );
  const turn = turnEventSchema.parse(event).turn;
  // The terminal envelope may omit items; retain separately streamed completed items.
  const items = new Map(turn.items.map((item) => [item.id, item]));
  for (const entry of events.entries) {
    if (
      entry.method === 'item/completed' &&
      entry.params.threadId === threadId &&
      entry.params.turnId === turnId
    )
      items.set(entry.params.item.id, entry.params.item);
  }
  return { ...turn, items: [...items.values()] };
}

for (const transport of liveTransports) {
  const directory = await privateDirectory('cfg-g2-');
  activeDirectory = directory;
  let client;
  let events = journal();
  let server;
  let approvalHandler;
  let threadId;
  let activeTurn;
  const handlers = () => ({
    onNotification: (event) => events.onNotification(event),
    onDisconnect: () => events.onDisconnect(),
    onServerRequest: async (request) => {
      if (approvalHandler) await approvalHandler(request);
      else await client.reject(request); // No blanket approval, even in test mode.
    },
  });
  // Thread-level overrides isolate integration hooks and connectors from test work.
  // Only known MCP names are disabled by flags supplied below; no credentials are read.
  const extraConfig = [
    'mcp_servers={}',
    'features.hooks=false',
    'features.plugins=false',
    'features.apps=false',
    'features.multi_agent=false',
    'features.shell_snapshot=false',
  ];
  try {
    server = await startServer({ directory, homeMode: values.home, transport, extraConfig });
    activeServer = server;
    await record(transport, 'handshake', async () => {
      client = await connectClient(server, handlers());
      return { ready: client.isReady, initializeId: 0, privateTransport: true };
    });
    if (!client) continue;
    await record(transport, 'integration-isolation', async () => {
      const schema = z.object({
        config: z.object({
          mcp_servers: z
            .record(z.string(), z.object({ enabled: z.boolean().optional() }))
            .default({}),
          features: z.record(z.string(), z.unknown()).default({}),
        }),
      });
      let result = await client.request(
        'config/read',
        { includeLayers: false, cwd: directory },
        schema,
      );
      const enabledNames = Object.entries(result.config.mcp_servers)
        .filter(([, entry]) => entry.enabled !== false)
        .map(([name]) => name);
      // Config tables merge: an empty mcp_servers table does not clear inherited entries.
      // Apply per-entry flags to this owned process only, then verify the effective config.
      if (enabledNames.length > 0) {
        client.close();
        await server.diagnostics(join(artifacts, `${transport}-bootstrap.private.log`));
        report.cleanup.push({ transport, stage: 'config-discovery', ...(await server.stop()) });
        if (enabledNames.some((name) => !/^[a-zA-Z0-9_-]+$/.test(name)))
          throw new ProbeBlocked('MCP name cannot be safely expressed as a CLI override');
        extraConfig.push(...enabledNames.map((name) => `mcp_servers.${name}.enabled=false`));
        server = await startServer({ directory, homeMode: values.home, transport, extraConfig });
        activeServer = server;
        events = journal();
        client = await connectClient(server, handlers());
        result = await client.request(
          'config/read',
          { includeLayers: false, cwd: directory },
          schema,
        );
      }
      const enabled = Object.values(result.config.mcp_servers).filter(
        (entry) => entry.enabled !== false,
      ).length;
      if (enabled > 0)
        throw new ProbeBlocked('Configured MCP servers remain enabled; do not start model turns');
      for (const feature of ['hooks', 'plugins', 'apps', 'multi_agent'])
        assert.equal(result.config.features[feature], false);
      return {
        enabledMcpServers: enabled,
        hooksDisabled: true,
        pluginsDisabled: true,
        appsDisabled: true,
        agentsDisabled: true,
      };
    });
    if (report.cases.at(-1).status !== 'PASS') continue;
    if (transport === 'ws')
      await record(transport, 'health', async () => {
        const url = server.endpoint.replace('ws:', 'http:');
        const statuses = [];
        for (const path of ['/readyz', '/healthz'])
          statuses.push((await fetch(url + path, { signal: AbortSignal.timeout(5_000) })).status);
        assert.deepEqual(statuses, [200, 200]);
        return { statuses };
      });
    let historical;
    let paginatedHistory;
    await record(transport, 'thread-list', async () => {
      const list = await client.request(
        'thread/list',
        { limit: 50, modelProviders: [], useStateDbOnly: true },
        threadListSchema,
      );
      historical = list.data.find((thread) => thread.historyMode === 'legacy');
      paginatedHistory = list.data.find((thread) => thread.historyMode === 'paginated');
      return {
        count: list.data.length,
        hasCursor: Boolean(list.nextCursor),
        historyModes: [...new Set(list.data.map((thread) => thread.historyMode))],
      };
    });
    if (values.home === 'existing')
      await record(transport, 'historical-read', async () => {
        if (!historical)
          throw new ProbeBlocked(
            'No legacy history in first page; this CLI cannot read paginated history',
          );
        const read = await client.request(
          'thread/read',
          { threadId: historical.id, includeTurns: true },
          threadResultSchema,
        );
        assert.equal(read.thread.id, historical.id);
        assert.ok(read.thread.turns.length > 0);
        return {
          turnCount: read.thread.turns.length,
          statuses: [...new Set(read.thread.turns.map((turn) => turn.status))],
          contentRecorded: false,
        };
      });
    if (values.home === 'existing' && paginatedHistory)
      await record(transport, 'paginated-history-read', async () => {
        const page = await client.request(
          'thread/turns/list',
          { threadId: paginatedHistory.id, limit: 2, itemsView: 'full' },
          turnsPageSchema,
        );
        assert.ok(page.data.length > 0);
        return {
          turnCount: page.data.length,
          statuses: [...new Set(page.data.map((turn) => turn.status))],
          contentRecorded: false,
          method: 'thread/turns/list',
          itemsView: 'full',
        };
      });
    await record(transport, 'start-request-rejected', async () => {
      await assert.rejects(
        client.request(
          'turn/start',
          { threadId: randomUUID(), input: input('G2 nonexistent thread test') },
          turnResultSchema,
        ),
        (error) => error instanceof RpcRejectedError,
      );
      return { phase: 'rpc-rejection', turnCreated: false };
    });
    if (!values.live) continue;
    await record(transport, 'account-status', async () => {
      const account = await client.request(
        'account/read',
        { refreshToken: false },
        z.object({
          account: z.object({ type: z.string() }).nullable(),
          requiresOpenaiAuth: z.boolean(),
        }),
      );
      if (!account.account && account.requiresOpenaiAuth)
        throw new ProbeBlocked('No existing account login');
      return {
        accountType: account.account?.type ?? null,
        requiresOpenaiAuth: account.requiresOpenaiAuth,
      };
    });
    if (report.cases.at(-1).status !== 'PASS') continue;
    const liveStartIndex = report.cases.length;
    const canContinue = () =>
      !report.cases.slice(liveStartIndex).some((entry) => entry.status !== 'PASS');
    const selected = (suite) => canContinue() && (values.suite === 'all' || values.suite === suite);
    async function createThread() {
      const result = await client.request(
        'thread/start',
        {
          ...GATEWAY_THREAD_POLICY,
          cwd: directory,
          historyMode: 'legacy',
          developerInstructions:
            'This is a bounded Gateway protocol test. Work only in the supplied test directory. Do not read personal data, call connectors, use the browser, spawn agents, or change configuration. Only run a command if the user explicitly supplies that exact command. Do not retry a rejected command. Keep final responses short.',
          config: { notify: [], model_reasoning_effort: 'low' },
        },
        threadResultSchema,
        45_000,
      );
      threadId = result.thread.id;
      assert.equal(result.thread.historyMode, 'legacy');
      return threadId;
    }
    async function start(text) {
      if (!threadId) await createThread();
      const result = await client.request(
        'turn/start',
        { threadId, input: input(text), effort: 'low' },
        turnResultSchema,
        45_000,
      );
      activeTurn = { threadId, turnId: result.turn.id };
      console.log(
        JSON.stringify({ transport, step: 'turn-submitted', status: result.turn.status }),
      );
      return result.turn.id;
    }
    async function requireCompleted(turn) {
      if (turn.status === 'failed') {
        report.cases.push({
          transport,
          name: 'observed-failed-terminal',
          status: 'PASS',
          evidence: summarizeTurn(turn),
        });
        // Error text remains only in a private local file.
        await writeFile(
          join(artifacts, `${transport}-turn-error.private.json`),
          JSON.stringify(turn.error, null, 2),
          { mode: 0o600 },
        );
        throw new ProbeBlocked('Model turn failed; inspect private error evidence');
      }
      assert.equal(turn.status, 'completed');
    }
    if (selected('completed'))
      await record(transport, 'completed-and-history', async () => {
        const turnId = await start('Reply exactly G2_COMPLETED. Do not use tools.');
        const turn = await terminal(events, threadId, turnId);
        await requireCompleted(turn);
        assert.match(finalText(turn), /G2_COMPLETED/);
        const read = await client.request(
          'thread/read',
          { threadId, includeTurns: true },
          threadResultSchema,
        );
        assert.ok(read.thread.turns.some((entry) => entry.id === turnId));
        return { terminal: summarizeTurn(turn), persistedTurn: true };
      });
    if (values.suite === 'rpc-controls') {
      await record(transport, 'steer-accepted-reconnect-interrupt', async () => {
        const turnId = await start('Reply G2_CONTROL. Do not use tools.');
        await events.wait(
          'turn/started',
          (params) => params.threadId === threadId && params.turn?.id === turnId,
          5_000,
        );
        const steered = await client.request(
          'turn/steer',
          {
            threadId,
            expectedTurnId: turnId,
            input: input('Final response should be G2_STEER_CONTROL.'),
          },
          steerResultSchema,
        );
        assert.equal(steered.turnId, turnId);
        const oldEpoch = client.connectionEpoch;
        client.close();
        events = journal();
        client = await connectClient(server, handlers());
        assert.notEqual(client.connectionEpoch, oldEpoch);
        const resumed = await client.request(
          'thread/resume',
          { threadId, cwd: directory, ...GATEWAY_THREAD_POLICY },
          threadResultSchema,
        );
        assert.equal(resumed.thread.id, threadId);
        const read = await client.request(
          'thread/read',
          { threadId, includeTurns: true },
          threadResultSchema,
        );
        assert.ok(read.thread.turns.some((turn) => turn.id === turnId));
        await client.request('turn/interrupt', { threadId, turnId }, emptyResultSchema);
        const turn = await terminal(events, threadId, turnId);
        assert.equal(turn.status, 'interrupted');
        return {
          steerAcceptedForSameTurn: true,
          steerGeneratedResultVerified: false,
          newConnectionEpoch: true,
          historyBackfilled: true,
          terminalOnNewConnection: summarizeTurn(turn),
        };
      });
    }
    if (selected('controls')) {
      await record(transport, 'steer', async () => {
        const turnId = await start(
          'Run exactly `/bin/sleep 6` in the test directory, then reply ORIGINAL. Do not run any other command.',
        );
        const response = await client.request(
          'turn/steer',
          {
            threadId,
            expectedTurnId: turnId,
            input: input('Change the final response to exactly G2_STEERED instead of ORIGINAL.'),
          },
          steerResultSchema,
        );
        assert.equal(response.turnId, turnId);
        const turn = await terminal(events, threadId, turnId);
        await requireCompleted(turn);
        assert.match(finalText(turn), /G2_STEERED/);
        return { sameTurn: true, terminal: summarizeTurn(turn), markerObserved: true };
      });
      if (canContinue())
        await record(transport, 'interrupt', async () => {
          const turnId = await start(
            'Run exactly `/bin/sleep 20` in the test directory, then reply DONE. Do not run any other command.',
          );
          // A start response is not proof the execution loop is ready to interrupt.
          await events.wait(
            'item/started',
            (params) =>
              params.threadId === threadId &&
              params.turnId === turnId &&
              params.item?.type === 'commandExecution',
          );
          await client.request('turn/interrupt', { threadId, turnId }, emptyResultSchema);
          const turn = await terminal(events, threadId, turnId);
          assert.equal(turn.status, 'interrupted');
          return summarizeTurn(turn);
        });
    }
    if (selected('approvals')) {
      for (const decision of ['accept', 'decline']) {
        if (!canContinue()) break;
        await record(transport, `approval-${decision}`, async () => {
          await createThread();
          let observed;
          let approvalItemId;
          approvalHandler = async (request) => {
            if (request.method !== 'item/commandExecution/requestApproval')
              return client.reject(request);
            const params = commandApprovalSchema.parse(request.params);
            // Only this exact inert command/cwd is preauthorized by the live probe.
            const selection = fixtureApprovalDecision(params, {
              threadId,
              directory,
              decision,
              alreadyAnswered: Boolean(observed),
            });
            if (!selection.matches) {
              await writeFile(
                join(artifacts, `${transport}-approval-unmatched.private.json`),
                JSON.stringify(params, null, 2),
                { mode: 0o600 },
              );
              if (selection.decision)
                return client.respond(request, { decision: selection.decision });
              return client.reject(request);
            }
            const wireDecision = selection.decision;
            observed = {
              requestedDecision: decision,
              decision: wireDecision,
              requestIdType: typeof request.id,
              requestIdIsZero: request.id === 0,
            };
            approvalItemId = params.itemId;
            await client.respond(request, { decision: wireDecision });
          };
          try {
            const turnId = await start(
              'Request explicit command approval using sandbox_permissions="require_escalated" for exactly `/usr/bin/printf G2_APPROVAL_PROBE`, with the current test directory as workdir. This harmless command is a protocol approval fixture; do not wrap it in another command. After the result (including rejection), stop and reply G2_APPROVAL_FINISHED. Do not retry or use any other tool.',
            );
            const turn = await terminal(events, threadId, turnId);
            if (decision === 'accept' || turn.status === 'failed') await requireCompleted(turn);
            else assert.ok(['completed', 'interrupted'].includes(turn.status));
            if (!observed)
              throw new ProbeBlocked('No exact fixture approval observed; no approval accepted');
            const executed = turn.items.find(
              (item) => item.id === approvalItemId && item.type === 'commandExecution',
            );
            assert.ok(executed, 'Approved command item must reach a terminal state');
            if (decision === 'accept') {
              assert.equal(executed.exitCode, 0);
              assert.ok(String(executed.aggregatedOutput ?? '').includes('G2_APPROVAL_PROBE'));
            } else {
              assert.equal(executed.status, 'declined');
              assert.ok(!String(executed.aggregatedOutput ?? '').includes('G2_APPROVAL_PROBE'));
            }
            return {
              ...observed,
              terminal: summarizeTurn(turn),
              commandResult: turn.items
                .filter((item) => item.type === 'commandExecution')
                .map((item) => ({
                  status: item.status,
                  exitCode: item.exitCode,
                  markerObserved: String(item.aggregatedOutput ?? '').includes('G2_APPROVAL_PROBE'),
                })),
            };
          } finally {
            approvalHandler = undefined;
          }
        });
      }
    }
    if (selected('recovery')) {
      await record(transport, 'reconnect-resume-subscription', async () => {
        await createThread();
        const turnId = await start(
          'Run exactly `/bin/sleep 10` in the test directory, then reply G2_RECONNECTED. Do not run other commands.',
        );
        await events.wait(
          'item/started',
          (params) =>
            params.threadId === threadId &&
            params.turnId === turnId &&
            params.item?.type === 'commandExecution',
        );
        const oldEpoch = client.connectionEpoch;
        client.close();
        events = journal();
        client = await connectClient(server, handlers());
        assert.notEqual(client.connectionEpoch, oldEpoch);
        const resumed = await client.request(
          'thread/resume',
          { threadId, cwd: directory, ...GATEWAY_THREAD_POLICY },
          threadResultSchema,
          45_000,
        );
        assert.equal(resumed.thread.id, threadId);
        const read = await client.request(
          'thread/read',
          { threadId, includeTurns: true },
          threadResultSchema,
        );
        assert.ok(read.thread.turns.some((turn) => turn.id === turnId));
        const turn = await terminal(events, threadId, turnId);
        await requireCompleted(turn);
        assert.match(finalText(turn), /G2_RECONNECTED/);
        return {
          newConnectionEpoch: true,
          historyBackfilled: true,
          terminalOnNewConnection: summarizeTurn(turn),
        };
      });
    }
    if (canContinue() && (selected('recovery') || values.suite === 'rpc-controls'))
      await record(transport, 'pending-request-disconnect', async () => {
        const pending = client
          .request(
            'command/exec',
            {
              command: ['/bin/sleep', '2'],
              cwd: directory,
              sandboxPolicy: {
                type: 'workspaceWrite',
                writableRoots: [directory],
                networkAccess: false,
                excludeTmpdirEnvVar: false,
                excludeSlashTmp: false,
              },
              timeoutMs: 5_000,
            },
            z.unknown(),
          )
          .catch((error) => error);
        await delay(200);
        client.close();
        const error = await pending;
        assert.ok(error instanceof RpcTransportError);
        assert.equal(error.outcome, 'unknown');
        assert.equal(client.pendingRequestCount, 0);
        events = journal();
        client = await connectClient(server, handlers());
        return { outcome: error.outcome, pendingCleared: true, replayed: false };
      });
  } catch (error) {
    report.cases.push({
      transport,
      name: 'probe-environment',
      status: 'BLOCKED',
      error: { type: error.name, code: error.code ?? null },
    });
    console.log(JSON.stringify(report.cases.at(-1)));
  } finally {
    await writeFile(
      join(artifacts, `${transport}-errors.private.json`),
      JSON.stringify(
        events.entries.filter((entry) => entry.method === 'error'),
        null,
        2,
      ),
      { mode: 0o600 },
    );
    if (client?.isReady && activeTurn) {
      const final = events.entries.some(
        (event) =>
          event.method === 'turn/completed' &&
          event.params.threadId === activeTurn.threadId &&
          event.params.turn?.id === activeTurn.turnId,
      );
      if (!final) {
        try {
          await client.request('turn/interrupt', activeTurn, emptyResultSchema, 5_000);
          await events.wait(
            'turn/completed',
            (params) =>
              params.threadId === activeTurn.threadId && params.turn?.id === activeTurn.turnId,
            5_000,
          );
          report.cleanup.push({ transport, interruptedOwnedActiveTurn: true });
        } catch {
          report.cleanup.push({
            transport,
            interruptedOwnedActiveTurn: false,
            fallback: 'stop-owned-app-server',
          });
        }
      }
    }
    client?.close();
    if (server) {
      await server.diagnostics(join(artifacts, `${transport}-server.private.log`));
      report.cleanup.push({ transport, ...(await server.stop()) });
    }
    activeServer = undefined;
    await cleanupDirectory(directory);
    activeDirectory = undefined;
    report.cleanup.push({ transport, temporaryDirectoryRemoved: true, userHistoryDeleted: false });
    await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
    });
  }
}
report.status = report.cases.some((entry) => entry.status === 'FAIL')
  ? 'FAIL'
  : report.cases.some((entry) => entry.status === 'BLOCKED')
    ? 'BLOCKED'
    : 'PASS';
await writeFile(join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
  mode: 0o600,
});
console.log(JSON.stringify({ status: report.status, report: join(artifacts, 'report.json') }));
process.exitCode = report.status === 'PASS' ? 0 : 1;
