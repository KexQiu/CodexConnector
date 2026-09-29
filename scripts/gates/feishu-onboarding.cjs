// Run with Electron, not Node: the gate uses the same Keychain-backed cipher as the app.
const { app, safeStorage, nativeImage } = require('electron');
const { registerApp } = require('@larksuiteoapi/node-sdk');
const { createRequire } = require('node:module');
const { mkdirSync, writeFileSync, existsSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { parseArgs } = require('node:util');
const qr = createRequire(resolve('apps/desktop/package.json'))('qrcode-generator');
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    root: { type: 'string' },
    name: { type: 'string', default: 'CodexConnector F0 测试' },
    app: { type: 'string' },
  },
});
if (!values.root) throw new Error('必须显式指定独立 --root，不读取现有凭据');
const root = resolve(values.root);
process.umask(0o077);
mkdirSync(root, { recursive: true, mode: 0o700 });
if (existsSync(join(root, 'feishu-setup.json')))
  throw new Error('该档案已有应用，请用 App 继续配置，不重复创建');
app.setPath('userData', root);
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
app
  .whenReady()
  .then(async () => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Keychain 不可用');
    safeStorage.encryptString('preflight');
    const manifest = require(join(root, '..', 'manifest.json'));
    const timer = setTimeout(() => controller.abort(), 660000);
    try {
      const result = await registerApp({
        ...(values.app ? { appId: values.app } : { createOnly: true }),
        appPreset: { name: values.name, desc: 'CodexConnector 独立配置验收应用' },
        addons: {
          preset: false,
          scopes: manifest.scopes,
          events: { items: { tenant: manifest.events } },
          callbacks: { items: manifest.callbacks },
        },
        source: 'codexconnector-f0',
        signal: controller.signal,
        onQRCodeReady({ url, expireIn }) {
          if (controller.signal.aborted) return;
          const address = new URL(url);
          if (
            !['accounts.feishu.cn', 'open.feishu.cn'].includes(address.hostname) ||
            address.protocol !== 'https:'
          ) {
            controller.abort();
            throw new Error('不支持的授权域名');
          }
          const code = qr(0, 'M');
          code.addData(url);
          code.make();
          const image = nativeImage.createFromDataURL(code.createDataURL(6, 24));
          writeFileSync(join(root, 'authorization.png'), image.toPNG(), { mode: 0o600 });
          writeFileSync(
            join(root, 'authorization.json'),
            JSON.stringify({ url, expiresAt: Date.now() + expireIn * 1000 }),
            { mode: 0o600 },
          );
          console.log(
            JSON.stringify({
              state: 'QR_READY',
              image: join(root, 'authorization.png'),
              expiresAt: Date.now() + expireIn * 1000,
              host: address.hostname,
            }),
          );
        },
        onStatusChange({ status }) {
          if (status === 'domain_switched') controller.abort();
          if (status !== 'polling') console.log(JSON.stringify({ state: status }));
        },
      });
      if (values.app && values.app !== result.client_id) throw new Error('返回应用不匹配');
      if (result.user_info?.tenant_brand === 'lark') throw new Error('仅支持国内飞书');
      const pending = {
        appId: result.client_id,
        encryptedSecret: safeStorage.encryptString(result.client_secret).toString('base64'),
        ...(result.user_info?.open_id ? { scannerOpenId: result.user_info.open_id } : {}),
      };
      writeFileSync(
        join(root, 'feishu-setup.json'),
        JSON.stringify({ version: 1, pending, tutorial: [], check: null }),
        { mode: 0o600, flag: 'wx' },
      );
      console.log(
        JSON.stringify({
          state: 'CREDENTIALS_ENCRYPTED',
          hasScannerIdentity: !!pending.scannerOpenId,
        }),
      );
    } finally {
      clearTimeout(timer);
    }
  })
  .then(
    () => app.quit(),
    (error) => {
      // Never print SDK error messages, HTTP request objects or registration results.
      console.log(
        JSON.stringify({
          state: 'FAILED',
          code: ['access_denied', 'expired_token', 'abort'].includes(error?.code)
            ? error.code
            : 'setup-failed',
        }),
      );
      app.exit(1);
    },
  );
