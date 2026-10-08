import { Backend as DesktopBackend } from '../../../src/desktop/backend-client.js';

// Keep the Electron host API while distinguishing desktop IPC from Codex RPC.
export class Backend extends DesktopBackend {
  request<T = unknown>(method: string, args?: unknown): Promise<T> {
    return this.invoke<T>(method, args);
  }
}
