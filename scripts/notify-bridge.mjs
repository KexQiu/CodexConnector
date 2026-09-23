// Standalone on purpose: forwarding the original notifier must not depend on app dependencies.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { request } from 'node:http';
import { clearTimeout, setTimeout } from 'node:timers';

process.umask(0o077);
const MAX = 256 * 1024;
const hash = (value) => createHash('sha256').update(value).digest('hex');
// The app's rich-text copy may escape underscores in synthetic gate markers.
// Normalize only gate comparisons; forward/capture the original argument bytes unchanged.
const markerText = (value) => (typeof value === 'string' ? value.replaceAll('\\_', '_') : '');
const [settingsPath, originalJson, ...args] = process.argv.slice(2);
const original = JSON.parse(originalJson);
let captureFile;
if (!Array.isArray(original) || !original.every((s) => typeof s === 'string'))
  throw new Error('Invalid original notify command');

// Forward first. Inherit fd 0 verbatim: no EOF wait, consumption, truncation or stdin rewriting.
const forwarded = original.length
  ? new Promise((resolve) => {
      const child = spawn(original[0], [...original.slice(1), ...args], {
        stdio: 'inherit',
        shell: false,
      });
      child.once('error', () => resolve(127));
      child.once('exit', (code) => resolve(code ?? 1));
    })
  : Promise.resolve(0);

function privateDir(path) {
  if (!isAbsolute(path)) throw new Error('absolute-directory-required');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory() || st.uid !== process.getuid() || st.mode & 0o077)
    throw new Error('private-directory-required');
}
function read(path, max = MAX) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid() || st.mode & 0o077 || st.size > max)
      throw new Error('private-file-required');
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}
function syncDir(path) {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function durableFile(dir, name, data) {
  const temporary = join(dir, `${randomUUID()}.tmp`),
    target = join(dir, name);
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temporary, target);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  } finally {
    unlinkSync(temporary);
  }
  syncDir(dir);
  return target;
}
function post(settings, token, body, identity) {
  return new Promise((resolve) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: settings.port,
        path: '/notify',
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '',
          size = 0;
        res.on('error', () => resolve(false));
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 4096) {
            req.destroy();
            resolve(false);
          } else data += chunk;
        });
        res.on('end', () => {
          try {
            const ack = JSON.parse(data);
            resolve(
              res.statusCode === 200 &&
                ack.identity === identity &&
                ['queued', 'duplicate', 'suppressed-rpc-owned'].includes(ack.outcome),
            );
          } catch {
            resolve(false);
          }
        });
      },
    );
    const deadline = setTimeout(() => {
      req.destroy();
      resolve(false);
    }, 1200);
    req.once('close', () => clearTimeout(deadline));
    req.on('error', () => resolve(false));
    req.end(body);
  });
}
async function forwardGateway() {
  const settings = JSON.parse(read(settingsPath));
  if (settings.version !== 1 || !['capture', 'forward', 'disabled'].includes(settings.mode))
    throw new Error('invalid-settings');
  if (settings.mode === 'disabled') return;
  if (args.length !== 1 || Buffer.byteLength(args[0]) > MAX) throw new Error('invalid-notify-argv');
  const raw = JSON.parse(args[0]);
  if (typeof raw.cwd !== 'string' || !isAbsolute(raw.cwd)) throw new Error('missing-cwd');
  if (
    !Array.isArray(settings.allowedRoots) ||
    !settings.allowedRoots.some((r) => realpathSync(r) === realpathSync(raw.cwd))
  )
    return;
  if (settings.mode === 'capture') {
    if (!Number.isSafeInteger(settings.captureUntil) || Date.now() > settings.captureUntil) return;
    if (typeof settings.captureMarker !== 'string' || settings.captureMarker.length < 8) return;
    if (
      ![
        raw['last-assistant-message'],
        ...(Array.isArray(raw['input-messages']) ? raw['input-messages'] : []),
      ].some((s) => markerText(s).includes(markerText(settings.captureMarker)))
    )
      return;
    privateDir(settings.captureDir);
    if (readdirSync(settings.captureDir).filter((n) => n.endsWith('.json')).length >= 20)
      throw new Error('capture-limit');
    const st = fstatSync(0);
    captureFile = durableFile(
      settings.captureDir,
      `${Date.now()}-${randomUUID()}.json`,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          argv: args,
          original,
          stdin: {
            isTTY: !!process.stdin.isTTY,
            kind: st.isFIFO()
              ? 'pipe'
              : st.isFile()
                ? 'file'
                : st.isCharacterDevice()
                  ? 'character'
                  : 'other',
            capturedBytes: 0,
            strategy: 'inherited-without-reading',
          },
          evidence: 'invocation-only-origin-requires-manual-GUI-correlation',
        },
        null,
        2,
      ),
    );
    return;
  }
  if (
    !Array.isArray(settings.verifiedEvents) ||
    !settings.verifiedEvents.includes(raw.type) ||
    raw.type !== 'agent-turn-complete'
  )
    return;
  // A live gate can restrict forwarding to its exact synthetic final marker.
  if (
    settings.testMarker &&
    markerText(raw['last-assistant-message']).trim() !== markerText(settings.testMarker)
  )
    return;
  for (const key of ['thread-id', 'turn-id'])
    if (typeof raw[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(raw[key]))
      throw new Error('missing-identity');
  if (
    raw['last-assistant-message'] !== undefined &&
    typeof raw['last-assistant-message'] !== 'string'
  )
    throw new Error('invalid-message');
  if (!Number.isInteger(settings.port) || settings.port < 1024 || settings.port > 65535)
    throw new Error('invalid-port');
  const event = {
    type: raw.type,
    'thread-id': raw['thread-id'],
    'turn-id': raw['turn-id'],
    cwd: raw.cwd,
    'last-assistant-message': (raw['last-assistant-message'] ?? '').slice(-1800),
  };
  const identity = hash(JSON.stringify([event.type, event['thread-id'], event['turn-id']]));
  privateDir(settings.spoolDir);
  const files = readdirSync(settings.spoolDir).filter((n) => /^[a-f0-9]{64}\.json$/.test(n));
  if (
    files.length >= 1000 ||
    files.reduce((sum, name) => sum + lstatSync(join(settings.spoolDir, name)).size, 0) >=
      64 * 1024 * 1024
  )
    throw new Error('spool-limit');
  // Always commit locally BEFORE attempting HTTP; a lost ACK is retried with the same identity.
  const path = durableFile(settings.spoolDir, `${identity}.json`, JSON.stringify(event));
  const body = read(path);
  const token = read(settings.tokenFile, 256).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('invalid-token');
  if (await post(settings, token, body, identity)) {
    try {
      unlinkSync(path);
      syncDir(settings.spoolDir);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
try {
  await forwardGateway();
} catch {
  // Fixed, body-free diagnostic. Failure never prevents the already-started original notifier.
  try {
    const dir = settingsPath.slice(0, settingsPath.lastIndexOf('/'));
    privateDir(dir);
    const temp = join(dir, `${randomUUID()}.tmp`);
    writeFileSync(
      temp,
      JSON.stringify({ at: new Date().toISOString(), error: 'notify-extension-failed' }),
      { flag: 'wx', mode: 0o600 },
    );
    renameSync(temp, join(dir, 'bridge-error.json'));
  } catch {
    /* Original notification still completes independently. */
  }
}
process.exitCode = await forwarded;
if (captureFile) {
  try {
    const captured = JSON.parse(read(captureFile));
    const temporary = `${captureFile}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ ...captured, originalExitCode: process.exitCode }), {
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, captureFile);
  } catch {
    /* A capture failure does not change the original notifier's result. */
  }
}
