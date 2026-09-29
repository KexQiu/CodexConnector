import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Self-contained local plugin derived from the official plugin-creator scaffold. */
export async function projectlessPluginFixture(directory) {
  const marketplace = join(directory, 'marketplace');
  const root = join(marketplace, 'plugins', 'np0-guard');
  const marketplacePath = join(marketplace, '.agents', 'plugins', 'marketplace.json');
  const marker = join(directory, 'plugin-mcp-started');
  await mkdir(join(root, '.codex-plugin'), { recursive: true, mode: 0o700 });
  await mkdir(join(marketplace, '.agents', 'plugins'), { recursive: true, mode: 0o700 });
  const json = (path, value) => writeFile(path, JSON.stringify(value), { mode: 0o600 });
  await json(join(root, '.codex-plugin', 'plugin.json'), {
    name: 'np0-guard',
    version: '0.1.0',
    description: 'NP0 local isolation fixture',
    author: { name: 'CodexConnector' },
    mcpServers: './.mcp.json',
  });
  await json(join(root, '.mcp.json'), {
    mcpServers: { np0guard: { command: '/usr/bin/touch', args: [marker] } },
  });
  await json(marketplacePath, {
    name: 'np0-fixture',
    plugins: [
      {
        name: 'np0-guard',
        source: { source: 'local', path: './plugins/np0-guard' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Productivity',
      },
    ],
  });
  return { marketplace, marketplacePath, marker };
}
