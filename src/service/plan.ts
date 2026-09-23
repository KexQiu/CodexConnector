import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadConfig, runtimePaths, servicePolicySchema } from '../config/schema.js';
import { runDoctor } from '../cli/doctor.js';
import { gatewayCredentials } from '../feishu/credentials.js';
import { TaskError } from '../tasks/types.js';
import { privateDirectory, readPrivate, servicePaths, writeJson, writePrivate } from './files.js';
import { roles, ServiceLeases, type ServiceRole } from './state.js';

export const labels = {
  'app-server': 'io.codexconnector.app-server',
  gateway: 'io.codexconnector.gateway',
};
const absolute = z.string().refine(isAbsolute);
export const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  application: z.literal('CodexConnector'),
  uid: z.number().int(),
  preparedAt: z.string(),
  configPath: absolute,
  configHash: z.string(),
  dataDir: absolute,
  node: absolute,
  binary: absolute,
  entry: absolute,
  buildHash: z.string(),
  codexHome: absolute,
  policy: servicePolicySchema,
  plistHashes: z.object({ 'app-server': z.string(), gateway: z.string() }),
});
export type ServiceManifest = z.infer<typeof manifestSchema>;
export const digest = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
export function buildHash(entry: string) {
  const root = dirname(entry),
    hash = createHash('sha256');
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name),
        stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new TaskError('构建目录不能包含符号链接');
      if (stat.isDirectory()) visit(path);
      else if (/\.(js|json|sql)$/.test(name))
        hash.update(path.slice(root.length)).update(readFileSync(path));
    }
  };
  visit(root);
  return hash.digest('hex');
}
const xml = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
export function renderPlist(manifest: ServiceManifest, role: ServiceRole) {
  const args = [
    manifest.node,
    manifest.entry,
    'service-run',
    role,
    '--config',
    manifest.configPath,
  ];
  const env = {
    PATH: `${dirname(manifest.node)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    CODEX_HOME: manifest.codexHome,
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${labels[role]}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(manifest.dataDir)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(env)
    .map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`)
    .join('')}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>15</integer><key>ExitTimeOut</key><integer>60</integer>
<key>Umask</key><integer>63</integer><key>ProcessType</key><string>Background</string>
<key>AbandonProcessGroup</key><false/>
<key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>\n`;
}
export function readManifest(dataDir: string) {
  const manifest = manifestSchema.parse(JSON.parse(readPrivate(servicePaths(dataDir).manifest)));
  if (manifest.uid !== process.getuid?.() || manifest.dataDir !== dataDir)
    throw new TaskError('部署清单归属不匹配');
  return manifest;
}
export async function validateManifest(manifest: ServiceManifest) {
  if (
    digest(readPrivate(manifest.configPath)) !== manifest.configHash ||
    buildHash(manifest.entry) !== manifest.buildHash
  )
    throw new TaskError('配置或构建已变化：先停止服务，重新生成部署清单');
  if (
    realpathSync(process.execPath) !== manifest.node ||
    (await runDoctor(manifest.binary)).status !== 'ok'
  )
    throw new TaskError('Node/Codex 运行基线不兼容');
  const config = await loadConfig(manifest.configPath);
  if (
    config.dataDir !== manifest.dataDir ||
    config.codex.endpoint !== `unix://${runtimePaths(config.dataDir).socket}` ||
    realpathSync(config.codex.binary) !== manifest.binary
  )
    throw new TaskError('部署目录或 socket 与配置不一致');
  gatewayCredentials(config);
  return config;
}
export async function prepareServices(configPath: string) {
  if (process.platform !== 'darwin') throw new TaskError('LaunchAgent 仅支持 macOS');
  const raw = readPrivate(configPath),
    config = await loadConfig(configPath);
  gatewayCredentials(config);
  if (!isAbsolute(config.codex.binary)) throw new TaskError('常驻服务必须使用绝对 Codex 路径');
  const socket = runtimePaths(config.dataDir).socket;
  if (config.codex.endpoint !== `unix://${socket}` || Buffer.byteLength(socket) > 103)
    throw new TaskError('常驻服务要求 dataDir 下不超过 103 字节的专用 Unix socket 路径');
  const entry = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
  if (!existsSync(entry)) throw new TaskError('请先 pnpm build');
  const manifest: ServiceManifest = {
    schemaVersion: 1,
    application: 'CodexConnector',
    uid: process.getuid!(),
    preparedAt: new Date().toISOString(),
    configPath,
    configHash: digest(raw),
    dataDir: config.dataDir,
    node: realpathSync(process.execPath),
    binary: realpathSync(config.codex.binary),
    entry: realpathSync(entry),
    buildHash: buildHash(entry),
    codexHome: realpathSync(process.env.CODEX_HOME ?? join(homedir(), '.codex')),
    policy: servicePolicySchema.parse(config.service ?? {}),
    plistHashes: { 'app-server': '', gateway: '' },
  };
  await validateManifest(manifest);
  const leases = new ServiceLeases(config.dataDir);
  try {
    if (leases.active().length) throw new TaskError('请先停止服务再重新准备部署');
  } finally {
    leases.close();
  }
  const paths = servicePaths(config.dataDir);
  for (const dir of [paths.logs, paths.backups]) privateDirectory(dir);
  for (const role of roles) {
    const path = join(paths.root, `${labels[role]}.plist`);
    const content = renderPlist(manifest, role);
    manifest.plistHashes[role] = digest(content);
    writePrivate(path, content);
    execFileSync('/usr/bin/plutil', ['-lint', path], { stdio: 'pipe' });
  }
  writeJson(paths.manifest, manifest);
  return manifest;
}
