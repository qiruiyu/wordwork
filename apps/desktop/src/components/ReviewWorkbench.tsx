import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../lib/store';
import { ApiError, applyConflictsFrom } from '../lib/api';
import * as native from '../lib/native';
import type { CommentView, DiffPayload, Hunk, HunkStatus } from '../types';
import { COMPLEX_OBJECT_CAVEAT, OPERATION_LABELS, redlineWarningLabel } from '../lib/format';
import { describe, detailOf } from './Workspace';
import { Banner, Caveat, EmptyState, ErrorState, Field, Modal, Spinner, StatusPill, formatTime, locationLabel } from './ui';

export function ReviewWorkbench({
  submissionId,
  isTeacher,
  roundOpen,
  onClose,
  onChanged,
}: {
  submissionId: number;
  isTeacher: boolean;
  roundOpen: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { api, pushToast } = useApp();
  const [diff, setDiff] = useState<DiffPayload | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState('');
  const [comments, setComments] = useState<CommentView[]>([]);
  const [commentDraft, setCommentDraft] = useState('');
  const [sideBySide, setSideBySide] = useState(true);
  const [redlineName, setRedlineName] = useState('');
  const [manualNotice, setManualNotice] = useState<string[]>([]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [payload, commentList] = await Promise.all([api.getDiff(submissionId), api.listComments(submissionId)]);
      setDiff(payload);
      setComments(commentList);
    } catch (e) {
      setError(e);
    }
  }, [api, submissionId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(hunk: Hunk, decision: HunkStatus) {
    setBusy(`hunk-${hunk.id}`);
    try {
      await api.decideHunk(submissionId, hunk.id, decision);
      setDiff((current) =>
        current ? { ...current, hunks: current.hunks.map((h) => (h.id === hunk.id ? { ...h, decision } : h)) } : current,
      );
    } catch (e) {
      pushToast('error', '保存决定失败', [describe(e)]);
    } finally {
      setBusy('');
    }
  }

  async function bulk(decision: HunkStatus) {
    if (!diff) return;
    const targets = diff.hunks.filter((h) => h.decision !== decision);
    if (targets.length === 0) return;
    setBusy('bulk');
    try {
      for (const hunk of targets) {
        await api.decideHunk(submissionId, hunk.id, decision);
        // Apply the change locally as each call succeeds instead of refetching the
        // whole diff at the end: the server is the source of truth, but rebuilding
        // the list after every batch is what made the modal visibly flash and lose
        // the teacher's scroll position.
        setDiff((current) =>
          current
            ? { ...current, hunks: current.hunks.map((h) => (h.id === hunk.id ? { ...h, decision } : h)) }
            : current,
        );
      }
    } catch (e) {
      // Whatever already succeeded stays applied (and matches the server); the rest
      // keep their previous state, so nothing is left claiming a decision the server
      // never recorded.
      pushToast('error', '批量操作失败', [describe(e)]);
    } finally {
      setBusy('');
    }
  }

  async function finalize() {
    if (!diff) return;
    setBusy('finalize');
    setManualNotice([]);
    try {
      const result = await api.finalizeReview(submissionId);
      pushToast('success', '这份提交已完成审阅');
      if (result.warnings?.length) {
        pushToast('info', '有片段是按文字套用的，建议下载结果核对', result.warnings);
      }
      onChanged();
      onClose();
    } catch (e) {
      // 409 with `conflicts` means the server accepted the teacher's decisions but
      // refused to apply some of them on its own — this submission is now parked in
      // `manual_required` and must not look "done" in the UI.
      const conflicts = applyConflictsFrom(e);
      if (conflicts.length) {
        setManualNotice(conflicts.map((c) => c.detail || c.reason));
        pushToast('error', '这份提交需要人工合并', conflicts.map((c) => c.detail || c.reason));
      } else {
        pushToast('error', '完成审阅失败', [describe(e), ...(detailOf(e) ?? [])]);
      }
    } finally {
      setBusy('');
    }
  }

  async function downloadRedline() {
    if (!diff?.redline_version_id) return;
    setBusy('redline');
    try {
      const { bytes, filename } = await api.downloadVersion(diff.redline_version_id);
      const target = await native.pickSavePath(filename);
      if (!target) return;
      const problem = await native.saveDocument(target, bytes);
      if (problem) {
        pushToast('error', '无法保存红线稿', [problem]);
        return;
      }
      setRedlineName(target);
      pushToast('success', `红线稿已保存到 ${target}`, ['用 Word 打开即可看到原生修订。']);
    } catch (e) {
      pushToast('error', '下载红线稿失败', [describe(e)]);
    } finally {
      setBusy('');
    }
  }

  async function sendComment() {
    const body = commentDraft.trim();
    if (!body) return;
    try {
      const created = await api.addComment(submissionId, body);
      setComments((current) => [...current, created]);
      setCommentDraft('');
    } catch (e) {
      pushToast('error', '发表评论失败', [describe(e)]);
    }
  }

  const pending = diff?.hunks.filter((h) => h.decision === 'pending').length ?? 0;
  const canDecide = isTeacher && roundOpen;

  return (
    <Modal
      wide
      title="修改片段审阅"
      onClose={onClose}
      footer={
        <div className="workbench-foot">
          <span>
            {diff ? `共 ${diff.hunks.length} 个片段，待处理 ${pending} 个` : '正在加载…'}
          </span>
          <div className="row-actions">
            <button className="secondary" onClick={() => void downloadRedline()} disabled={!diff?.redline_version_id || busy !== ''}>
              下载红线稿
            </button>
            {canDecide && (
              <button className="primary" disabled={busy !== '' || pending > 0 || !diff?.hunks.length} onClick={() => void finalize()}>
                {busy === 'finalize' ? '处理中…' : '完成这份提交的审阅'}
              </button>
            )}
          </div>
        </div>
      }
    >
      {!diff && error === null && <Spinner label="正在读取差异…" />}
      {error !== null && <ErrorState message={describe(error)} detail={detailOf(error)} onRetry={() => void load()} />}

      {diff && (
        <>
          {diff.engine_available === false && (
            <Banner tone="error" title="服务器缺少 DOCX 差异引擎">
              请联系管理员在服务器上安装 wordwork-doc-engine。
            </Banner>
          )}

          {diff.hunks.length > 0 && (
            <Caveat kind="design" title="公式、图片等复杂对象不会在这里展开">
              <p>{COMPLEX_OBJECT_CAVEAT}</p>
            </Caveat>
          )}

          {diff.redline_warnings.length > 0 && (
            <Caveat kind="warning" title="红线稿没能完整表达这些改动">
              <p>下面这些改动服务器无法写进红线稿，红线稿只反映其余部分：</p>
              <ul>
                {diff.redline_warnings.map((warning) => (
                  <li key={warning}>{redlineWarningLabel(warning)}</li>
                ))}
              </ul>
              <p>请下载这份提交的原始文件，用 Word/WPS 打开对照后再做判定。</p>
            </Caveat>
          )}

          {manualNotice.length > 0 && (
            <Caveat kind="required" title="这些片段必须人工合并，系统不会自动套用">
              <p>
                服务器已套用能自动处理的部分，但下面这些改动无法安全自动套用，所以这份提交<strong>不会</strong>被标记为已审阅：
              </p>
              <ul>
                {manualNotice.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <p>请下载红线稿/结果稿，在 Word/WPS 中人工整理后，用「上传人工合并结果」发布；或把这份提交标记为跳过。</p>
            </Caveat>
          )}

          {diff.hunks.length === 0 ? (
            <EmptyState title="这份提交没有可审阅的文字改动" hint="成员可能只修改了图片、公式或其他复杂对象。" />
          ) : (
            <>
              <div className="review-toolbar">
                <span className="muted">修改说明：{diff.note || '（未填写）'}</span>
                <div className="view-toggle">
                  <button className={sideBySide ? 'on' : ''} onClick={() => setSideBySide(true)}>
                    左右对照
                  </button>
                  <button className={!sideBySide ? 'on' : ''} onClick={() => setSideBySide(false)}>
                    内联
                  </button>
                </div>
              </div>

              {canDecide && (
                <div className="row-actions bulk-actions">
                  <button className="secondary" disabled={busy !== ''} onClick={() => void bulk('accepted')}>
                    全部接受
                  </button>
                  <button className="secondary" disabled={busy !== ''} onClick={() => void bulk('rejected')}>
                    全部拒绝
                  </button>
                </div>
              )}

              {diff.hunks.map((hunk) => (
                <HunkRow
                  key={hunk.id}
                  hunk={hunk}
                  canDecide={canDecide}
                  sideBySide={sideBySide}
                  busy={busy === `hunk-${hunk.id}`}
                  onDecide={decide}
                  currentFilename={redlineName}
                />
              ))}
            </>
          )}

          <section className="comments">
            <h3>评论</h3>
            {comments.length === 0 && <p className="muted">还没有评论。所有项目成员都可以在这里讨论。</p>}
            {comments.map((comment) => (
              <div className="comment" key={comment.id}>
                <span className="mini-avatar">{comment.author[0]?.toUpperCase()}</span>
                <div>
                  <strong>
                    {comment.author} <small>{formatTime(comment.created_at)}</small>
                  </strong>
                  <p>{comment.body}</p>
                </div>
              </div>
            ))}
            <Field label="发表评论">
              <textarea
                rows={2}
                value={commentDraft}
                placeholder="例如：这一段建议保留原数据，我们下次会议确认。"
                onChange={(e) => setCommentDraft(e.target.value)}
              />
            </Field>
            <button className="secondary" disabled={!commentDraft.trim()} onClick={() => void sendComment()}>
              发表评论
            </button>
          </section>
        </>
      )}
    </Modal>
  );
}

function HunkRow({
  hunk,
  canDecide,
  sideBySide,
  busy,
  onDecide,
}: {
  hunk: Hunk;
  canDecide: boolean;
  sideBySide: boolean;
  busy: boolean;
  onDecide: (hunk: Hunk, decision: HunkStatus) => void;
  currentFilename?: string;
}) {
  const operationLabel = OPERATION_LABELS[hunk.operation] ?? '修改';
  // Formatting and complex-object hunks carry fingerprints, not text, so rendering
  // them as before/after prose would show meaningless hash fragments.
  const opaque = hunk.operation === 'format' || hunk.operation === 'structure';

  return (
    <article className={`hunk ${hunk.decision}`}>
      <div className="hunk-location">
        ⌖ {locationLabel(hunk.anchor)} · {operationLabel}
        {hunk.risk === 'high' && (
          <span
            className="pill red"
            title="这一段含公式、图片、域或超链接。界面不展开它们的内部差异，红线稿也可能不完整——请下载原始提交和红线稿，用 Word/WPS 人工核对。"
          >
            高风险
          </span>
        )}
        <span className="author-tag">{hunk.author}</span>
      </div>
      {opaque ? (
        <div className="hunk-note">
          {hunk.operation === 'format'
            ? '这一段只有格式变化（字体、字号、加粗、颜色、段落样式等），文字内容没有变。接受会整段采用对方的格式。'
            : '这一段的段落结构发生了变化（整段新增、删除或复杂对象改动），无法自动逐字套用——属于处理要求，必须人工合并。'}
        </div>
      ) : (
        <div className={sideBySide ? 'diff side' : 'diff'}>
          <div className="removed">
            <small>原内容</small>− {hunk.before || '（空）'}
          </div>
          <div className="added">
            <small>新内容</small>＋ {hunk.after || '（空）'}
          </div>
        </div>
      )}
      {canDecide && hunk.decision === 'pending' ? (
        <div className="hunk-actions">
          <button className="accept" disabled={busy} onClick={() => onDecide(hunk, 'accepted')}>
            ✓ 接受
          </button>
          <button className="reject" disabled={busy} onClick={() => onDecide(hunk, 'rejected')}>
            × 拒绝
          </button>
        </div>
      ) : (
        <div className="hunk-decision">
          <StatusPill status={hunk.decision} />
          {canDecide && (
            <button className="link" disabled={busy} onClick={() => onDecide(hunk, 'pending')}>
              撤销决定
            </button>
          )}
          {!canDecide && <span className="muted">只读预览</span>}
        </div>
      )}
    </article>
  );
}
