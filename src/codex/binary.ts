import { accessSync, constants, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const executable = (path: string) => {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
export function codexCandidates(home = homedir()): string[] {
  return ['/Applications', join(home, 'Applications')].flatMap((root) =>
    ['ChatGPT.app', 'Codex.app'].flatMap((app) => [
      join(root, app, 'Contents/Resources/codex-cli/bin/codex'),
      join(root, app, 'Contents/Resources/codex'),
    ]),
  );
}
/** Only repair the known old layout inside the same application bundle.
 * Never silently replace a user's missing custom CLI with a different installation.
 */
export function resolveCodexBinary(requested?: string): string {
  if (!requested) return codexCandidates().find(executable) ?? codexCandidates()[0]!;
  if (existsSync(requested)) return requested;
  if (/\/(?:ChatGPT|Codex)\.app\/Contents\/Resources\/codex$/.test(requested)) {
    const replacement = `${requested.slice(0, -'codex'.length)}codex-cli/bin/codex`;
    if (executable(replacement)) return replacement;
  }
  return requested;
}
