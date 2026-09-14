import { useEffect } from 'react';
import type { ReactNode } from 'react';

import { CAVEAT_LABELS } from '../lib/format';

export { KIND_LABELS, formatBytes, formatTime, locationLabel } from '../lib/format';

export function Spinner({ label = '正在加载…' }: { label?: string }) {
  return (
    <div className="state-block">
      <span className="spinner" />
      <p>{label}</p>
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="state-block empty">
      <div className="empty-icon">◌</div>
      <h3>{title}</h3>
      {hint && <p>{hint}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ message, detail, onRetry }: { message: string; detail?: string[]; onRetry?: () => void }) {
  return (
    <div className="state-block error">
      <div className="empty-icon">!</div>
      <h3>{message}</h3>
      {detail?.map((line) => (
        <p key={line} className="mono">
          {line}
        </p>
      ))}
      {onRetry && (
        <button className="secondary" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
}

export function Banner({
  tone,
  title,
  children,
  onClose,
}: {
  tone: 'info' | 'warn' | 'error' | 'success';
  title: string;
  children?: ReactNode;
  onClose?: () => void;
}) {
  return (
    <div className={`banner ${tone}`}>
      <div>
        <strong>{title}</strong>
        {children && <div className="banner-body">{children}</div>}
      </div>
      {onClose && (
        <button className="text-btn" onClick={onClose} aria-label="关闭提示">
          关闭
        </button>
      )}
    </div>
  );
}

/**
 * A notice whose category is spelled out and colour-coded.
 *
 * The three categories this app needs to distinguish — a rendering limit, a real
 * redline warning, and a "merge this by hand" instruction — look identical if they
 * are all rendered as a plain sentence. Labelling the category in the title means
 * the distinction survives even for a reader who does not read the body.
 */
export function Caveat({
  kind,
  title,
  children,
}: {
  kind: 'design' | 'warning' | 'required';
  title: string;
  children?: ReactNode;
}) {
  const tone = kind === 'design' ? 'info' : kind === 'warning' ? 'warn' : 'error';
  return (
    <div className={`banner caveat ${tone}`}>
      <div>
        <strong>
          <span className="caveat-kind">{CAVEAT_LABELS[kind]}</span>
          {title}
        </strong>
        {children && <div className="banner-body">{children}</div>}
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function Modal({
  title,
  children,
  onClose,
  footer,
  wide,
  dismissible = true,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  wide?: boolean;
  /** `false` removes every way out (×, Esc, backdrop). Used for forced actions. */
  dismissible?: boolean;
}) {
  useEffect(() => {
    if (dismissible) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [dismissible]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className={wide ? 'modal wide' : 'modal'}>
        <div className="modal-head">
          <h2>{title}</h2>
          {dismissible && (
            <button className="icon-btn" onClick={onClose} aria-label="关闭">
              ×
            </button>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const map: Record<string, { text: string; tone: string }> = {
    draft: { text: '草稿', tone: 'grey' },
    open: { text: '进行中', tone: 'green' },
    reviewing: { text: '审阅中', tone: 'yellow' },
    published: { text: '已发布', tone: 'blue' },
    submitted: { text: '已提交', tone: 'grey' },
    ready_for_review: { text: '待审阅', tone: 'yellow' },
    reviewed: { text: '已审阅', tone: 'green' },
    skipped: { text: '已跳过', tone: 'grey' },
    rejected: { text: '已拒绝', tone: 'red' },
    manual_required: { text: '需人工合并', tone: 'red' },
    diff_failed: { text: '差异生成失败', tone: 'red' },
    pending: { text: '待处理', tone: 'yellow' },
    accepted: { text: '已接受', tone: 'green' },
  };
  const entry = map[status] ?? { text: status, tone: 'grey' };
  return <span className={`pill ${entry.tone}`}>{entry.text}</span>;
}

