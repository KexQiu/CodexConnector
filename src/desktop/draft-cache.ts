import type { DesktopApi, DesktopSettings, DesktopSnapshot } from './contracts.js';

export type DraftCacheState = 'saved' | 'pending' | 'saving' | 'error';
type Draft = { settings: DesktopSettings; secret: string; revision: number };

/** One writer for automatic drafts, explicit saves, apply, and the exit barrier. */
export class DesktopDraftCache {
  private current: Draft;
  private savedRevision = 0;
  private cachedSecret: { appId: string; value: string } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(
    settings: DesktopSettings,
    private readonly api: Pick<DesktopApi, 'saveDraft' | 'apply'>,
    private readonly notify: (state: DraftCacheState) => void,
    private readonly saved: (snapshot: DesktopSnapshot, revision: number, applied: boolean) => void,
    private readonly delayMs = 600,
  ) {
    this.current = { settings, secret: '', revision: 0 };
  }

  update(settings: DesktopSettings, secret: string): number {
    this.current = { settings, secret, revision: this.current.revision + 1 };
    this.notify('pending');
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.flush().catch(() => {});
    }, this.delayMs);
    return this.current.revision;
  }

  private clearTimer() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    // A failed save must not poison retries or a later exit request.
    this.queue = next.catch(() => {});
    return next;
  }

  private async writePending() {
    while (this.savedRevision < this.current.revision) {
      const draft = this.current;
      if (!this.disposed) this.notify('saving');
      let snapshot: DesktopSnapshot;
      try {
        const reuseSecret =
          this.cachedSecret?.appId === draft.settings.feishu.appId &&
          this.cachedSecret.value === draft.secret;
        snapshot = await this.api.saveDraft(draft.settings, reuseSecret ? '' : draft.secret);
      } catch (error) {
        if (!this.disposed) this.notify('error');
        throw error;
      }
      this.savedRevision = draft.revision;
      this.cachedSecret = { appId: draft.settings.feishu.appId, value: draft.secret };
      if (!this.disposed) this.saved(snapshot, draft.revision, false);
    }
    if (!this.disposed) this.notify('saved');
  }

  flush(): Promise<void> {
    this.clearTimer();
    return this.enqueue(() => this.writePending());
  }

  apply(): Promise<void> {
    this.clearTimer();
    return this.enqueue(async () => {
      // Cache incomplete inputs too, so validation failures don't discard edits.
      await this.writePending();
      const draft = this.current;
      const snapshot = await this.api.apply(draft.settings, draft.secret);
      if (this.current.revision === draft.revision) this.current = { ...draft, secret: '' };
      if (!this.disposed) this.saved(snapshot, draft.revision, true);
    });
  }

  dispose() {
    this.disposed = true;
    this.clearTimer();
  }
}
