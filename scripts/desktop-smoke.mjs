import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function verifyPackagedDesktop(appPath) {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
  // Launch the final Mach-O host: Node-only and codesign checks miss dyld failures.
  const output = execFileSync(
    join(appPath, 'Contents/MacOS/CodexConnector'),
    ['--connector-smoke-test'],
    {
      env,
      encoding: 'utf8',
      timeout: 30000,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const line = output.split('\n').find((line) => line.startsWith('CONNECTOR_DESKTOP_SMOKE '));
  if (!line) throw new Error('安装包没有返回界面启动验证结果');
  const result = JSON.parse(line.slice('CONNECTOR_DESKTOP_SMOKE '.length));
  if (
    !result.renderer ||
    !result.ipc ||
    result.configured ||
    result.phase !== 'stopped' ||
    result.feishuConnected
  )
    throw new Error('安装包界面、IPC 或独立档案验证失败');
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('用法：node scripts/desktop-smoke.mjs <App 路径>');
  console.log(JSON.stringify(verifyPackagedDesktop(resolve(process.argv[2])), null, 2));
}
