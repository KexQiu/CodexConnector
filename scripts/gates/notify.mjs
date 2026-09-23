import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { parseArgs } from 'node:util';
import { privateDirectory, readPrivate, writeJson } from '../../src/service/files.ts';
import { loadConfig } from '../../src/config/schema.ts';

const sha = (text) => createHash('sha256').update(text).digest('hex');
const defaultConfig = () =>
  join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');

// Codex Home may be 755. Do not change it to satisfy Gateway's separate 700 directory policy.
function replaceCodexConfig(path, before, after) {
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.uid !== process.getuid() || parent.mode & 0o022)
    throw new Error('Codex 配置父目录不安全');
  if (readPrivate(path) !== before) throw new Error('配置发生并发修改');
  const temporary = join(dirname(path), `.notify-${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, after);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (readPrivate(path) !== before) throw new Error('配置发生并发修改，临时文件保留待核对');
  renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

/** Deliberately constrained edit: refuse TOML forms we cannot preserve byte-for-byte. */
export function notifySetting(text) {
  const table = text.search(/^\s*\[(?!\s*\])/m);
  const root = table < 0 ? text : text.slice(0, table);
  if (root.includes('"""') || root.includes("'''"))
    throw new Error('顶层含多行字符串，拒绝猜测 TOML 边界');
  const candidates = [...root.matchAll(/^[ \t]*(?:notify|"notify"|'notify')[ \t]*=/gm)];
  if (!candidates.length) return { command: [], start: 0, end: 0, originalLine: '' };
  if (candidates.length !== 1) throw new Error('无法唯一识别顶层 notify');
  const start = candidates[0].index;
  const newline = text.indexOf('\n', start);
  const end = newline < 0 ? text.length : newline + 1;
  const line = text.slice(start, end);
  const value = line.match(/^[ \t]*notify[ \t]*=[ \t]*(\[.*\])[ \t]*(?:#[^\r\n]*)?\r?\n?$/)?.[1];
  if (!value) throw new Error('仅支持顶层单行 JSON 兼容 notify 数组；请勿自动改写其它 TOML 形式');
  const command = JSON.parse(value);
  if (
    !Array.isArray(command) ||
    command.length > 32 ||
    !command.every((s) => typeof s === 'string' && !s.includes('\0')) ||
    (command.length && !isAbsolute(command[0]))
  )
    throw new Error('原 notify 需要绝对可执行路径及字符串参数数组');
  return { command, start, end, originalLine: line };
}
export function inspectNotify(path = defaultConfig()) {
  if (!isAbsolute(path)) throw new Error('Codex 配置需要绝对路径');
  const text = readPrivate(path);
  const setting = notifySetting(text);
  return {
    path,
    hash: sha(text),
    command: setting.command,
    scope: 'configuration-only-not-GUI-evidence',
  };
}
export function prepareNotify({ configPath = defaultConfig(), directory, root, now = Date.now() }) {
  if (!isAbsolute(directory) || !isAbsolute(root)) throw new Error('目录必须为绝对路径');
  if (existsSync(directory)) throw new Error('计划目录必须是新目录，不能覆盖旧备份');
  const text = readPrivate(configPath),
    setting = notifySetting(text);
  if (setting.command.some((s) => /notify-bridge\.mjs$/.test(s)))
    throw new Error('已安装 bridge，先恢复原配置');
  const allowedRoot = realpathSync(root);
  if (!lstatSync(allowedRoot).isDirectory()) throw new Error('捕获范围必须是目录');
  privateDirectory(directory);
  const bridge = join(directory, 'notify-bridge.mjs');
  const source = readFileSync(new URL('../notify-bridge.mjs', import.meta.url), 'utf8');
  writeFileSync(bridge, source, { flag: 'wx', mode: 0o600 });
  const settingsPath = join(directory, 'bridge.json');
  const captureMarker = `M6GUI${randomUUID().slice(0, 8).toUpperCase()}`;
  writeJson(settingsPath, {
    version: 1,
    mode: 'capture',
    allowedRoots: [allowedRoot],
    captureDir: join(directory, 'captures'),
    captureUntil: now + 20 * 60_000,
    captureMarker,
  });
  const wrapper = [
    realpathSync(process.execPath),
    bridge,
    settingsPath,
    JSON.stringify(setting.command),
  ];
  const line = `notify = ${JSON.stringify(wrapper)}\n`;
  const proposed = text.slice(0, setting.start) + line + text.slice(setting.end);
  writeFileSync(join(directory, 'original.toml'), text, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(directory, 'proposed.toml'), proposed, { flag: 'wx', mode: 0o600 });
  const plan = {
    version: 1,
    state: 'PREPARED',
    preparedAt: new Date(now).toISOString(),
    configPath,
    originalHash: sha(text),
    proposedHash: sha(proposed),
    bridgeHash: sha(source),
    originalCommand: setting.command,
    originalLine: setting.originalLine,
    wrapper,
    allowedRoot,
    captureMarker,
    settingsPath,
  };
  writeJson(join(directory, 'plan.json'), plan);
  return {
    directory,
    status: plan.state,
    originalCommand: setting.command,
    captureRoot: allowedRoot,
    captureMarker,
    next: '审核 proposed.toml 后执行 install；捕获窗口 20 分钟；不重启桌面或 M5 服务',
  };
}
function readPlan(directory) {
  if (!isAbsolute(directory)) throw new Error('计划目录必须是绝对路径');
  const plan = JSON.parse(readPrivate(join(directory, 'plan.json')));
  if (
    plan.version !== 1 ||
    !isAbsolute(plan.configPath) ||
    plan.settingsPath !== join(directory, 'bridge.json') ||
    !Array.isArray(plan.wrapper)
  )
    throw new Error('无效计划');
  return plan;
}
export function installNotify(directory) {
  const plan = readPlan(directory);
  const original = readPrivate(join(directory, 'original.toml'));
  const proposed = readPrivate(join(directory, 'proposed.toml'));
  if (
    sha(original) !== plan.originalHash ||
    sha(proposed) !== plan.proposedHash ||
    sha(readPrivate(join(directory, 'notify-bridge.mjs'))) !== plan.bridgeHash
  )
    throw new Error('计划/备份/bridge 摘要不匹配');
  if (sha(readPrivate(plan.configPath)) !== plan.originalHash)
    throw new Error('配置已改变或已安装，拒绝覆盖');
  const settings = JSON.parse(readPrivate(plan.settingsPath));
  if (
    settings.mode !== 'capture' ||
    JSON.stringify(settings.allowedRoots) !== JSON.stringify([plan.allowedRoot])
  )
    throw new Error('只能安装已审核的捕获模式');
  settings.captureUntil = Date.now() + 20 * 60_000;
  writeJson(plan.settingsPath, settings);
  // Intent remains available if the process exits between config replacement and completion.
  writeJson(join(directory, 'plan.json'), { ...plan, state: 'INSTALLING' });
  if (sha(readPrivate(plan.configPath)) !== plan.originalHash) throw new Error('配置发生并发修改');
  replaceCodexConfig(plan.configPath, original, proposed);
  writeJson(join(directory, 'plan.json'), {
    ...plan,
    state: 'INSTALLED',
    installedAt: new Date().toISOString(),
  });
  return {
    status: 'CAPTURE_INSTALLED',
    captureUntil: new Date(settings.captureUntil).toISOString(),
    scope: 'capture-only-no-Feishu-send',
    restore: `pnpm gate:notify restore --directory ${directory}`,
  };
}
export function restoreNotify(directory) {
  const plan = readPlan(directory);
  const original = readPrivate(join(directory, 'original.toml'));
  if (sha(original) !== plan.originalHash) throw new Error('备份摘要不匹配');
  const current = readPrivate(plan.configPath);
  const setting = notifySetting(current);
  if (JSON.stringify(setting.command) !== JSON.stringify(plan.wrapper)) {
    if (JSON.stringify(setting.command) === JSON.stringify(plan.originalCommand))
      return { status: 'ALREADY_RESTORED' };
    throw new Error('notify 已由其他程序修改，拒绝覆盖');
  }
  const restored = current.slice(0, setting.start) + plan.originalLine + current.slice(setting.end);
  // Keep unrelated settings changed after installation.
  if (readPrivate(plan.configPath) !== current) throw new Error('配置发生并发修改');
  replaceCodexConfig(plan.configPath, current, restored);
  writeJson(plan.settingsPath, { ...JSON.parse(readPrivate(plan.settingsPath)), mode: 'disabled' });
  writeJson(join(directory, 'plan.json'), {
    ...plan,
    state: 'RESTORED',
    restoredAt: new Date().toISOString(),
  });
  return {
    status: 'RESTORED',
    identicalToBackup: sha(restored) === plan.originalHash,
    originalCommand: plan.originalCommand,
  };
}

/** Produce reviewable files only; does not enable forwarding or overwrite a running config. */
export async function stageForward({ directory, gatewayConfig, projectKey, port = 43179 }) {
  const plan = readPlan(directory);
  const config = await loadConfig(gatewayConfig);
  const project = config.projects.find((p) => p.key === projectKey);
  if (!project || realpathSync(project.root) !== plan.allowedRoot)
    throw new Error('项目必须与捕获范围一致');
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('端口必须为 1024–65535');
  const tokenFile = join(directory, 'token');
  if (!existsSync(tokenFile))
    writeFileSync(tokenFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  if (!/^[a-f0-9]{64}$/.test(readPrivate(tokenFile).trim())) throw new Error('通知令牌格式错误');
  const policy = {
    port,
    tokenFile,
    spoolDir: join(directory, 'spool'),
    projectKeys: [projectKey],
    verifiedEvents: ['agent-turn-complete'],
  };
  privateDirectory(policy.spoolDir);
  writeJson(join(directory, 'gateway.proposed.json'), { ...config, notify: policy });
  writeJson(join(directory, 'bridge.forward.proposed.json'), {
    version: 1,
    mode: 'forward',
    allowedRoots: [plan.allowedRoot],
    port,
    tokenFile,
    spoolDir: policy.spoolDir,
    verifiedEvents: policy.verifiedEvents,
  });
  return {
    status: 'STAGED_NOT_ENABLED',
    directory,
    gatewayConfig: join(directory, 'gateway.proposed.json'),
    bridgeConfig: join(directory, 'bridge.forward.proposed.json'),
    gate: '仅在 G3 捕获通过并完成部署切换后启用；当前 M5 观察基线未修改',
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const { values, positionals } = parseArgs({
    options: {
      config: { type: 'string' },
      directory: { type: 'string' },
      root: { type: 'string' },
      'gateway-config': { type: 'string' },
      project: { type: 'string' },
      port: { type: 'string' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
  });
  try {
    let result;
    switch (values.help ? 'help' : positionals[0]) {
      case 'inspect':
        result = inspectNotify(values.config);
        break;
      case 'prepare':
        result = prepareNotify({
          configPath: values.config,
          directory: values.directory,
          root: values.root,
        });
        break;
      case 'install':
        result = installNotify(values.directory);
        break;
      case 'restore':
        result = restoreNotify(values.directory);
        break;
      case 'stage-forward':
        result = await stageForward({
          directory: values.directory,
          gatewayConfig: values['gateway-config'],
          projectKey: values.project,
          port: values.port === undefined ? 43179 : Number(values.port),
        });
        break;
      default:
        result = {
          usage: [
            'pnpm gate:notify inspect [--config /absolute/config.toml]',
            'pnpm gate:notify prepare --directory /new/private/plan --root /allowed/project [--config /absolute/config.toml]',
            'pnpm gate:notify install --directory /private/plan',
            'pnpm gate:notify restore --directory /private/plan',
            'pnpm gate:notify stage-forward --directory /private/plan --gateway-config /absolute/gateway.json --project KEY [--port 43179]',
          ],
          gate: 'G3 需要真实 GUI 调用和用户观察；手工调用 wrapper 不能算 PASS',
        };
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
