// macOS-only asset generation; uses the project's Electron and system iconutil.
// Does not load the gateway, read settings, or start a connection.
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

if (process.platform !== 'darwin') throw new Error('Generate the macOS icon on macOS.');
const root = resolve(__dirname, '..');
const temporary = mkdtempSync(join(tmpdir(), 'connector-icons-'));
app.setPath('userData', join(temporary, 'electron'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');

app.whenReady().then(async () => {
  let window;
  try {
    app.dock?.hide();
    const mark = readFileSync(join(root, 'public/connector-mark.svg'), 'utf8');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="surface" x1="0" y1="0" x2="0.85" y2="1">
      <stop stop-color="#45664f"/><stop offset="0.5" stop-color="#2d4c3e"/><stop offset="1" stop-color="#1c342d"/>
    </linearGradient>
    <linearGradient id="edge" x1="0" y1="0" x2="0.7" y2="1">
      <stop stop-color="#b7d6aa" stop-opacity="0.45"/><stop offset="1" stop-color="#b7d6aa" stop-opacity="0.04"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="16" stdDeviation="14" flood-color="#0c2018" flood-opacity="0.22"/>
    </filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="184" fill="url(#surface)" filter="url(#shadow)"/>
  <rect x="102" y="102" width="820" height="820" rx="182" fill="none" stroke="url(#edge)" stroke-width="4"/>
  ${mark.replace('<svg ', '<svg x="176" y="176" width="672" height="672" ')}
</svg>\n`;
    const assets = join(root, 'assets');
    mkdirSync(assets, { recursive: true });
    const source = join(assets, 'app-icon.svg');
    writeFileSync(source, svg);
    window = new BrowserWindow({
      width: 1024,
      height: 1024,
      useContentSize: true,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    await window.loadFile(source);
    const image = await window.webContents.capturePage(
      { x: 0, y: 0, width: 1024, height: 1024 },
      { stayHidden: true, stayAwake: true },
    );
    if (image.isEmpty()) throw new Error('Icon rendering returned an empty image.');
    const iconset = join(temporary, 'app.iconset');
    mkdirSync(iconset);
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const png = image.resize({ width: size * scale, height: size * scale, quality: 'best' });
        writeFileSync(
          join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`),
          png.toPNG(),
        );
      }
    }
    execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(assets, 'app-icon.icns')]);
    writeFileSync(
      join(root, 'public/app-icon.png'),
      image.resize({ width: 1024, height: 1024, quality: 'best' }).toPNG(),
    );
    console.log('Generated app-icon.svg, app-icon.icns, and app-icon.png.');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    window?.destroy();
    app.quit();
    rmSync(temporary, { recursive: true, force: true });
  }
});
