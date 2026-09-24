import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { executionPolicy, assertThreadPolicy } from '../../src/tasks/project-policy.ts';
import {
  privateDirectory,
  startServer,
  connectClient,
  versionBaseline,
  cleanupDirectory,
} from './probe-support.mjs';

// No model turns, login, Feishu messages or writes outside the owned temporary directory.
const report = {
  baseline: versionBaseline(),
  scope: 'isolated Codex sandbox; no model/Feishu',
  cases: [],
};
const directory = await privateDirectory('cc-policy-');
const workspace = join(directory, 'workspace');
await mkdir(workspace);
const http = createServer((_req, res) => res.end('CFG_NETWORK_OK'));
let server, rpc;
const commandResult = z.object({ exitCode: z.number(), stdout: z.string(), stderr: z.string() });
try {
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const serverDirectory = join(directory, 'server');
  await mkdir(serverDirectory);
  server = await startServer({
    directory: serverDirectory,
    homeMode: 'isolated',
    transport: 'unix',
    extraConfig: [
      'features.hooks=false',
      'features.plugins=false',
      'features.apps=false',
      'features.multi_agent=false',
      'features.shell_snapshot=false',
      'mcp_servers={}',
    ],
  });
  rpc = await connectClient(server);
  for (const mode of ['read-only', 'workspace-write'])
    for (const networkAccess of [false, true]) {
      const project = { remotePermissions: { mode, networkAccess } },
        policy = executionPolicy(project, workspace);
      const response = await rpc.request(
        'thread/start',
        { ...policy.thread, ephemeral: true, historyMode: 'legacy' },
        z.object({ approvalPolicy: z.unknown(), sandbox: z.unknown() }),
      );
      assertThreadPolicy(project, workspace, response);
      const marker = join(workspace, `${mode}-${networkAccess}.txt`);
      const write = await rpc.request(
        'command/exec',
        {
          cwd: workspace,
          sandboxPolicy: policy.turn.sandboxPolicy,
          command: ['/bin/sh', '-c', 'printf CFG_WRITE_OK > "$1"', 'policy', marker],
          timeoutMs: 5000,
        },
        commandResult,
      );
      assert.equal(write.exitCode === 0, mode === 'workspace-write');
      assert.equal(existsSync(marker), mode === 'workspace-write');
      const outside = join(directory, `outside-${mode}-${networkAccess}.txt`);
      const denied = await rpc.request(
        'command/exec',
        {
          cwd: workspace,
          sandboxPolicy: policy.turn.sandboxPolicy,
          command: ['/bin/sh', '-c', 'printf SHOULD_NOT_WRITE > "$1"', 'policy', outside],
          timeoutMs: 5000,
        },
        commandResult,
      );
      assert.notEqual(
        denied.exitCode,
        0,
        `outside write accepted: ${JSON.stringify(response.sandbox)}`,
      );
      assert.equal(existsSync(outside), false);
      const network = await rpc.request(
        'command/exec',
        {
          cwd: workspace,
          sandboxPolicy: policy.turn.sandboxPolicy,
          command: [
            '/usr/bin/curl',
            '--silent',
            '--show-error',
            '--max-time',
            '2',
            '--noproxy',
            '*',
            `http://127.0.0.1:${http.address().port}`,
          ],
          timeoutMs: 5000,
        },
        commandResult,
      );
      assert.equal(network.exitCode === 0, networkAccess);
      if (networkAccess) assert.equal(network.stdout, 'CFG_NETWORK_OK');
      report.cases.push({
        mode,
        networkAccess,
        threadPolicy: 'PASS',
        workspaceWrite: 'PASS',
        outsideWriteDenied: 'PASS',
        network: 'PASS',
      });
    }
  report.status = 'PASS';
} catch (e) {
  report.status = 'FAIL';
  report.error = e.message;
  process.exitCode = 1;
} finally {
  rpc?.close();
  await server?.stop();
  await new Promise((resolve) => http.close(resolve));
  await cleanupDirectory(directory);
  const output = resolve(
    '.artifacts/local-policy',
    new Date().toISOString().replaceAll(':', '-') + '.json',
  );
  await mkdir(resolve('.artifacts/local-policy'), { recursive: true, mode: 0o700 });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ ...report, output }, null, 2));
}
