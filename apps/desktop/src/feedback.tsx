import { useEffect, useState } from 'react';

export interface FeedbackNotice {
  text: string;
  error: boolean;
  source?: 'feishu' | 'projects' | 'login' | 'runtime';
}

function NoticeCard({ notice, onDismiss }: { notice: FeedbackNotice; onDismiss: () => void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    // Errors need an explicit acknowledgement. Reading or interacting with a
    // success message must not make it disappear under the pointer or focus.
    if (notice.error || hovered || focused) return;
    const timer = window.setTimeout(onDismiss, 6_000);
    return () => window.clearTimeout(timer);
  }, [notice, hovered, focused, onDismiss]);

  return (
    <div
      className={`feedback-card ${notice.error ? 'error' : 'success'}`}
      role={notice.error ? 'alert' : 'status'}
      aria-atomic="true"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <span className="feedback-icon" aria-hidden="true">
        {notice.error ? '!' : '✓'}
      </span>
      <span className="feedback-message">{notice.text}</span>
      <button className="feedback-close" aria-label="关闭提示" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}

export function FeedbackViewport({
  notice,
  busy,
  cacheFailed,
  onDismiss,
  onRetrySave,
}: {
  notice: FeedbackNotice | null;
  busy: string;
  cacheFailed: boolean;
  onDismiss: () => void;
  onRetrySave: () => void;
}) {
  return (
    <section className="feedback-viewport" aria-label="操作反馈">
      {cacheFailed && (
        <div className="feedback-card error" role="alert" aria-atomic="true">
          <span className="feedback-icon" aria-hidden="true">
            !
          </span>
          <span className="feedback-message">
            本地缓存保存失败。请检查 Keychain 授权和数据目录写入权限，再重试保存。
          </span>
          <button className="feedback-retry" disabled={Boolean(busy)} onClick={onRetrySave}>
            重试保存
          </button>
        </div>
      )}
      {notice && <NoticeCard notice={notice} onDismiss={onDismiss} />}
      {busy && (
        <div className="feedback-card progress" role="status" aria-atomic="true">
          <span className="feedback-spinner" aria-hidden="true" />
          <span className="feedback-message">{busy}…</span>
        </div>
      )}
    </section>
  );
}
