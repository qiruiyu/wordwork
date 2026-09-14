export function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

export function formatBytes(size: number | null | undefined): string {
  if (size === null || size === undefined) return '—';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export const KIND_LABELS: Record<string, string> = {
  main: '主版本',
  submission: '成员提交',
  redline: '红线审阅稿',
  contribution: '已审阅结果',
  draft: '草稿快照',
  manual_merge: '人工合并结果',
  summary_redline: '本轮汇总红线',
};

/**
 * Version kinds a teacher may promote to the document's main version.
 *
 * Mirrors `RESTORABLE_VERSION_KINDS` in `services/api/app/main.py`, which enforces
 * the same list: hiding the button is not the control, a directly-typed version id
 * must still be refused server-side. A redline is a *view* of a submission and a
 * draft is half-finished work — promoting either is invisible afterwards, because
 * versions are immutable, so neither is offered.
 */
export const RESTORABLE_VERSION_KINDS = ['main', 'submission', 'manual_merge'];

export function isRestorableVersion(kind: string): boolean {
  return RESTORABLE_VERSION_KINDS.includes(kind);
}

const PART_LABELS: Array<[RegExp, string]> = [
  [/^word\/document\.xml$/, '正文'],
  [/^word\/header\d*\.xml$/, '页眉'],
  [/^word\/footer\d*\.xml$/, '页脚'],
  [/^word\/footnotes\.xml$/, '脚注'],
  [/^word\/endnotes\.xml$/, '尾注'],
];

/** Turn an engine match key (`part|kind|anchor`) into a human label. */
export function locationLabel(anchor: string): string {
  const [part = '', kind = ''] = anchor.split('|');
  const partLabel = PART_LABELS.find(([pattern]) => pattern.test(part))?.[1] ?? part ?? '文档';
  const kindLabel = kind === 'table_cell' ? '表格单元格' : '段落';
  return `${partLabel} · ${kindLabel}`;
}

export const OPERATION_LABELS: Record<string, string> = {
  insert: '新增',
  delete: '删除',
  replace: '替换',
  format: '格式修改',
  structure: '复杂对象修改',
};

/**
 * The three caveats a reviewer has to be able to tell apart, because they call for
 * completely different actions. A teacher read "the formula is not shown" as "the
 * software is broken"; that only happens when a deliberate rendering limit is
 * presented in the same breath as a real "this edit did not make it into the
 * redline" warning. Each is labelled and coloured separately in the UI.
 */
export const CAVEAT_LABELS = {
  /** A) Preview limitation: complex objects are never expanded in the difference view. */
  design: '设计限制',
  /** B) A real warning: the server could not express some change in the redline. */
  warning: '实际告警',
  /** C) An instruction: these hunks must be merged by hand, never auto-applied. */
  required: '处理要求',
} as const;

/**
 * Case A. Shown at the top of the submission list and of the difference modal.
 *
 * Deliberately *not* phrased as an error: not rendering OOXML internals of a formula
 * or a chart is a product trade-off. The copy points at the only reliable check —
 * open the real files in Word.
 */
export const COMPLEX_OBJECT_CAVEAT =
  '公式、图片、图表、域、超链接等复杂对象不会在界面里展开内部差异，也不做逐字合并——这是设计取舍，不是文件损坏。核对这些改动，请下载该提交的原始文件和红线稿，用 Word/WPS 打开对照。';

/**
 * Explain an engine redline warning.
 *
 * The server stores raw engine codes (`high_risk_block_not_redlined:word/document.xml|...`).
 * A teacher reading the review screen must not see those; they need to know what part of
 * the document they have to open in Word themselves.
 */
export function redlineWarningLabel(warning: string): string {
  const [code = '', anchor = ''] = warning.split(':', 2);
  const where = anchor ? `${locationLabel(anchor)}（${anchor}）` : '';
  switch (code) {
    case 'high_risk_block_not_redlined':
      return `${where} 含图片、公式、域或超链接，红线稿里没有标出这处改动，请用 Word 打开对照。`;
    case 'not_redlined_insert':
      return `${where} 是整块新增（例如新增表格），红线稿里没有体现，请用 Word 打开对照。`;
    case 'not_redlined_delete':
      return `${where} 被整块删除，红线稿里没有体现，请用 Word 打开对照。`;
    default:
      return warning;
  }
}
