import { useCallback, useEffect, useState } from 'react';
import { useApp, type EnqueueInput } from '../lib/store';
import {
  ApiError,
  MANUAL_REVIEW_STATUS,
  applyConflictsFrom,
  isTerminalSubmission,
  outstandingFrom,
  outstandingOf,
  sha256Hex,
} from '../lib/api';
import { shouldUploadDraft } from '../lib/drafter';
import { COMPLEX_OBJECT_CAVEAT, redlineWarningLabel } from '../lib/format';
import * as native from '../lib/native';
import type {
  ApplyConflictView,
  MergeConflictView,
  OutstandingSubmission,
  RoundDetail,
  Submission,
  WorkingCopy,
} from '../types';
import { ReviewWorkbench } from './ReviewWorkbench';
import { describe, detailOf } from './Workspace';
import { Banner, Caveat, EmptyState, ErrorState, Field, Modal, Spinner, StatusPill, formatTime, locationLabel } from './ui';

export function RoundPage({
  roundId,
  onBack,
  onChanged,
}: {
  roundId: number;
  onBack: () => void;
  onChanged: () => void;
}) {
  const {
    api,
    member,
    workingCopies,
    upsertWorkingCopy,
    removeWorkingCopy,
    pushToast,
    online,
    enqueueSubmission,
    revision,
  } = useApp();
  const isTeacher = member?.role === 'teacher';

  const [round, setRound] = useState<RoundDetail | null>(null);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [conflicts, setConflicts] = useState<MergeConflictView[]>([]);
  const [manualConflicts, setManualConflicts] = useState<ApplyConflictView[]>([]);
  const [outstanding, setOutstanding] = useState<OutstandingSubmission[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [openSubmission, setOpenSubmission] = useState<number | null>(null);
  const [busy, setBusy] = useState('');
  const [manualOpen, setManualOpen] = useState(false);

  const myCopy = workingCopies.find((c) => c.roundId === roundId);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const detail = await api.getRound(roundId);
      const [subs, conflictList] = await Promise.all([api.listSubmissions(roundId), api.listConflicts(roundId)]);
      setRound(detail);
      setSubmissions(subs);
      setConflicts(conflictList);
      setOutstanding([]);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [api, roundId]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  async function downloadWorkingCopy() {
    if (!round) return;
    setBusy('download');
    try {
      const { bytes, filename } = await api.downloadVersion(round.base_version_id);
      const suggested = `${round.project_name}_第${round.number}轮_工作副本.docx`;
      const target = await native.pickSavePath(suggested);
      if (!target) return;
      // Word/WPS may still hold the previous copy open; writing into a locked file
      // silently produces a truncated .docx. `saveDocument` waits for the lock AND
      // reports the real reason when it cannot write at all (a brand-new file name
      // is writable, not "occupied").
      const problem = await native.saveDocument(target, bytes);
      if (problem) {
        pushToast('error', '无法保存工作副本', [problem]);
        return;
      }
      upsertWorkingCopy({
        projectId: round.project_id,
        projectName: round.project_name,
        roundId: round.id,
        roundNumber: round.number,
        documentId: round.document_id,
        baseVersionId: round.base_version_id,
        baseVersionName: filename,
        localPath: target,
        sha256: await sha256Hex(bytes),
        updatedAt: new Date().toISOString(),
      });
      pushToast('success', `工作副本已保存到 ${target}`, ['可以点击「用 Word 打开」开始编辑。']);
    } catch (e) {
      pushToast('error', '下载工作副本失败', [describe(e)]);
    } finally {
      setBusy('');
    }
  }

  async function skipSubmission(submission: Submission) {
    const reason = window.prompt(`跳过 ${submission.author} 的这份提交？它会记为本轮已处理，不会进入合并。\n\n可填写原因（可留空）：`);
    if (reason === null) return;
    setBusy(`skip-${submission.id}`);
    try {
      await api.skipSubmission(submission.id, reason);
      pushToast('success', `已跳过 ${submission.author} 的提交`);
      await load();
      onChanged();
    } catch (e) {
      pushToast('error', '跳过失败', [describe(e)]);
    } finally {
      setBusy('');
    }
  }

  async function publishResult(choices: Record<string, string> = {}) {
    if (!round) return;
    setBusy('publish');
    try {
      const result = await api.publishResult(round.id, choices);
      pushToast('success', `第 ${round.number} 轮结果已发布`, [`新的主版本 #${result.version_id}`]);
      if (result.redline_warnings?.length) {
        // The summary redline is what the teacher hands round; if the engine could not
        // express a change in it, saying so afterwards beats a silently incomplete file.
        pushToast('info', '本轮汇总红线稿不完整', result.redline_warnings.map(redlineWarningLabel));
      }
      await native.notify('wordwork', `第 ${round.number} 轮结果已发布`);
      setConflicts([]);
      setOutstanding([]);
      setManualConflicts([]);
      await load();
      onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const pending = outstandingFrom(e);
        if (pending.length) {
          // The server refuses to publish while anyone is unreviewed; show exactly
          // who, because "还有提交没处理完" alone is impossible to act on.
          setOutstanding(pending);
          pushToast('error', '还有提交没有处理完，不能发布本轮结果', pending.map((x) => `${x.author ?? '未知成员'}（${x.status}）`));
        } else {
          const conflictsFromServer = applyConflictsFrom(e);
          if (conflictsFromServer.length) {
            setManualConflicts(conflictsFromServer);
            pushToast('error', '有改动需要人工合并', conflictsFromServer.map((c) => c.detail || c.reason));
          } else {
            pushToast('error', describe(e), detailOf(e));
          }
        }
      } else {
        pushToast('error', '发布结果失败', [describe(e)]);
      }
    } finally {
      setBusy('');
    }
  }

  // Only the *first* load blanks the page. Every hunk decision writes an audit event,
  // the event feed bumps `revision`, and this component reloads — so keying the
  // spinner on `loading` alone tore down the whole subtree, including the review
  // modal the teacher was working in. That unmount/remount is the flicker.
  if (loading && !round) return <Spinner />;
  if (error) return <ErrorState message={describe(error)} detail={detailOf(error)} onRetry={() => void load()} />;
  if (!round) return null;

  const reviewed = submissions.filter((s) => s.status === 'reviewed');
  const openConflicts = conflicts.filter((c) => c.status === 'open');
  const blocked = outstanding.length ? outstanding : outstandingOf(submissions);
  const needsManual = submissions.filter((s) => s.status === MANUAL_REVIEW_STATUS);
  const canPublish = blocked.length === 0 && reviewed.length > 0;

  return (
    <>
      <button className="link back" onClick={onBack}>
        ← 返回项目
      </button>

      <section className="hero">
        <div>
          <span className="eyebrow">
            {round.project_name} · {round.document_name}
          </span>
          <h2>
            第 {round.number} 轮协作 <StatusPill status={round.status} />
          </h2>
          <p>
            基础版本 #{round.base_version_id} · 发布于 {formatTime(round.created_at)} · 共 {submissions.length} 份提交
          </p>
        </div>
        {!isTeacher && round.status === 'open' && (
          <div className="row-actions">
            <button className="primary" disabled={busy !== ''} onClick={() => void downloadWorkingCopy()}>
              {busy === 'download' ? '下载中…' : '下载工作副本'}
            </button>
            {myCopy && (
              <button className="secondary" onClick={() => void native.openWithSystem(myCopy.localPath)}>
                用 Word 打开
              </button>
            )}
          </div>
        )}
      </section>

      {round.status === 'published' && (
        <Banner tone="success" title="本轮已结束并发布">
          本轮已只读。所有版本都可以在「版本历史」中下载；老师可以把任意历史版本恢复为主版本。
        </Banner>
      )}

      {openConflicts.length > 0 && isTeacher && (
        <Banner tone="warn" title={`有 ${openConflicts.length} 处多人冲突待解决`}>
          这些位置被多位成员修改。请选择保留哪一方，或上传人工合并后的 DOCX。
        </Banner>
      )}

      {!isTeacher && round.status === 'open' && (
        <StudentSubmitCard
          round={round}
          myCopy={myCopy}
          onDownloaded={() => void downloadWorkingCopy()}
          onSubmitted={() => {
            void load();
            onChanged();
          }}
          pushToast={pushToast}
          online={online}
          enqueue={enqueueSubmission}
          removeWorkingCopy={removeWorkingCopy}
        />
      )}

      <section className="card">
        <div className="card-head">
          <div>
            <h2>本轮提交</h2>
            <p>
              {isTeacher
                ? '逐份审阅成员提交，对每个修改片段接受或拒绝，然后发布本轮结果。'
                : '不必等自己提交，随时可以只读查看自己和同伴的修改与评论。'}
            </p>
          </div>
        </div>

        <Caveat kind="design" title="公式、图片等复杂对象不会在这里展开">
          <p>{COMPLEX_OBJECT_CAVEAT}</p>
          <p>
            请留意列表里的两种标记：标着「红线稿不完整」的提交，说明服务器没能把所有改动写进红线稿；
            状态为「需人工合并」的提交，说明其中的改动无法自动套用。两者都必须下载原文件人工核对，
            界面上的逐字对照不覆盖这些内容。
          </p>
        </Caveat>

        {submissions.length === 0 ? (
          <EmptyState
            title="还没有提交"
            hint={isTeacher ? '等待成员提交修改。' : '下载工作副本、在 Word/WPS 中编辑后回到这里提交。'}
          />
        ) : (
          submissions.map((submission) => (
            <div className="submission-row" key={submission.id}>
              <span className="mini-avatar">{submission.author[0]?.toUpperCase()}</span>
              <div className="submission-main">
                <strong>{submission.author}</strong>
                <p>
                  {formatTime(submission.created_at)} · 版本 #{submission.version_id}
                </p>
                {submission.note && <em className="note">“{submission.note}”</em>}
              </div>
              <div className="row-actions">
                {(submission.redline_warnings?.length ?? 0) > 0 && (
                  <span className="pill yellow" title={submission.redline_warnings.map(redlineWarningLabel).join('\n')}>
                    红线稿不完整
                  </span>
                )}
                <StatusPill status={submission.status} />
                <button className="link" onClick={() => setOpenSubmission(submission.id)}>
                  {isTeacher ? '审阅差异' : '查看差异'}
                </button>
                {isTeacher && round.status === 'open' && !isTerminalSubmission(submission.status) && (
                  <button
                    className="link"
                    disabled={busy !== ''}
                    onClick={() => void skipSubmission(submission)}
                  >
                    跳过
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </section>

      {isTeacher && round.status === 'open' && submissions.length > 0 && (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>发布本轮结果</h2>
              <p>
                已完成审阅 {reviewed.length} / {submissions.length} 份。发布后本轮变为只读，并生成新的主版本。
              </p>
            </div>
          </div>

          {manualConflicts.length > 0 && (
            <Banner tone="error" title={`有 ${manualConflicts.length} 处改动无法自动套用`}>
              <ul>
                {manualConflicts.map((c) => (
                  <li key={c.match_key}>{c.detail || c.reason}</li>
                ))}
              </ul>
              <p>请下载结果稿，在 Word/WPS 中人工整理后，用下方「上传人工合并结果」发布。</p>
            </Banner>
          )}

          {needsManual.length > 0 && (
            <Banner tone="error" title={`有 ${needsManual.length} 份提交需要人工合并`}>
              {needsManual.map((s) => s.author).join('、')}{' '}
              的提交里有服务器无法自动套用的改动（新增/删除段落，或含图片、公式、域、超链接的段落）。请下载已套用部分，在
              Word 中人工整理后，用「上传人工合并结果」发布；或把该提交标记为跳过。
            </Banner>
          )}

          {blocked.length > 0 && (
            <Banner tone="warn" title={`还有 ${blocked.length} 份提交没有处理完`}>
              未处理：{blocked.map((s) => `${s.author ?? '未知成员'}（${s.status}）`).join('、')}
              。请审阅后点击「完成这份提交的审阅」，或对不参与的提交点「跳过」。
            </Banner>
          )}

          {openConflicts.length > 0 && (
            <ConflictResolver
              conflicts={openConflicts}
              busy={busy !== ''}
              onResolve={(choices) => void publishResult(choices)}
              onManual={() => setManualOpen(true)}
            />
          )}
          <div className="row-actions">
            <button
              className="primary"
              disabled={busy !== '' || !canPublish}
              title={canPublish ? undefined : '需要所有提交都处于「已审阅 / 已跳过 / 已拒绝」状态，且至少有一份已审阅'}
              onClick={() => void publishResult({})}
            >
              {busy === 'publish' ? '正在发布…' : '发布本轮结果'}
            </button>
            <button className="secondary" disabled={busy !== ''} onClick={() => setManualOpen(true)}>
              上传人工合并结果
            </button>
          </div>
          {reviewed.length === 0 && <p className="muted">至少需要完成一份提交的审阅才能发布。</p>}
          {reviewed.length > 0 && blocked.length > 0 && (
            <p className="muted">所有提交处理完之后才能发布：未处理的提交会被服务器拒绝，不会被静默丢弃。</p>
          )}
        </section>
      )}

      {openSubmission !== null && (
        <ReviewWorkbench
          submissionId={openSubmission}
          isTeacher={isTeacher}
          roundOpen={round.status === 'open'}
          onClose={() => setOpenSubmission(null)}
          onChanged={() => {
            void load();
            onChanged();
          }}
        />
      )}

      {manualOpen && round && (
        <ManualMergeModal
          roundId={round.id}
          onClose={() => setManualOpen(false)}
          onDone={() => {
            setManualOpen(false);
            pushToast('success', '人工合并结果已发布');
            void load();
            onChanged();
          }}
          onError={(message) => pushToast('error', '上传失败', [message])}
        />
      )}
    </>
  );
}

function ConflictResolver({
  conflicts,
  busy,
  onResolve,
  onManual,
}: {
  conflicts: MergeConflictView[];
  busy: boolean;
  onResolve: (choices: Record<string, string>) => void;
  onManual: () => void;
}) {
  const [choices, setChoices] = useState<Record<string, string>>({});

  useEffect(() => {
    const initial: Record<string, string> = {};
    for (const conflict of conflicts) {
      if (conflict.current_author) initial[conflict.anchor] = conflict.current_author;
    }
    setChoices(initial);
  }, [conflicts]);

  return (
    <div className="conflict-list">
      {conflicts.map((conflict) => (
        <article className="conflict" key={conflict.id}>
          <div className="conflict-head">
            <strong>{locationLabel(conflict.anchor)}</strong>
            <span className="pill yellow">
              {conflict.current_author || '已有结果'} 与 {conflict.incoming_author || '另一份提交'}
            </span>
          </div>
          <div className="conflict-grid">
            <label className={choices[conflict.anchor] === conflict.current_author ? 'chosen' : ''}>
              <input
                type="radio"
                name={`conflict-${conflict.id}`}
                checked={choices[conflict.anchor] === conflict.current_author}
                onChange={() => setChoices((c) => ({ ...c, [conflict.anchor]: conflict.current_author ?? '' }))}
              />
              <span className="who">{conflict.current_author || '已合并内容'}</span>
              <p>{conflict.current_text || '（无内容）'}</p>
            </label>
            <label className={choices[conflict.anchor] === conflict.incoming_author ? 'chosen' : ''}>
              <input
                type="radio"
                name={`conflict-${conflict.id}`}
                checked={choices[conflict.anchor] === conflict.incoming_author}
                onChange={() => setChoices((c) => ({ ...c, [conflict.anchor]: conflict.incoming_author ?? '' }))}
              />
              <span className="who">{conflict.incoming_author || '另一份提交'}</span>
              <p>{conflict.incoming_text || '（无内容）'}</p>
            </label>
          </div>
          <p className="muted">原始内容：{conflict.base_text || '（无）'}</p>
        </article>
      ))}
      <div className="row-actions">
        <button className="primary" disabled={busy} onClick={() => onResolve(choices)}>
          按所选方案合并并发布
        </button>
        <button className="secondary" disabled={busy} onClick={onManual}>
          改为上传人工合并结果
        </button>
      </div>
    </div>
  );
}

function StudentSubmitCard({
  round,
  myCopy,
  onDownloaded,
  onSubmitted,
  pushToast,
  online,
  enqueue,
  removeWorkingCopy,
}: {
  round: RoundDetail;
  myCopy: WorkingCopy | undefined;
  onDownloaded: () => void;
  onSubmitted: () => void;
  pushToast: (tone: 'info' | 'success' | 'error', text: string, detail?: string[]) => void;
  online: boolean;
  enqueue: (input: EnqueueInput) => Promise<void>;
  removeWorkingCopy: (roundId: number, baseVersionId: number) => void;
}) {
  const { api } = useApp();
  const [pending, setPending] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [draftState, setDraftState] = useState<{
    watchedSha: string | null;
    watchedAt: number;
    uploadedSha: string | null;
    lastUploadAt: number;
  }>({ watchedSha: null, watchedAt: 0, uploadedSha: null, lastUploadAt: 0 });

  /**
   * Periodically upload a draft snapshot of the working copy so the teacher can see
   * progress before the student formally submits. Re-reads the file each tick because
   * the whole point is to notice edits made in Word outside this app.
   */
  useEffect(() => {
    if (!myCopy || round.status !== 'open') return;
    let cancelled = false;
    const tick = async () => {
      const bytes = await native.readFile(myCopy.localPath);
      if (cancelled) return;
      const currentSha = bytes ? await sha256Hex(bytes) : null;
      setDraftState((previous) => {
        const watchedSha = currentSha === null || currentSha === previous.watchedSha ? previous.watchedSha : currentSha;
        const watchedAt = watchedSha === previous.watchedSha ? previous.watchedAt : Date.now();
        const now = Date.now();
        const ready = shouldUploadDraft({
          currentSha,
          uploadedSha: previous.uploadedSha ?? null,
          watchedSha,
          watchedAt,
          lastUploadAt: previous.lastUploadAt,
          now,
        });
        if (!ready || !bytes || !currentSha) return { ...previous, watchedSha, watchedAt };
        void api
          .uploadDraft(round.id, round.base_version_id, myCopy.localPath.split(/[\\/]/).pop() ?? 'draft.docx', bytes)
          .then(() => pushToast('info', '已自动上传草稿，老师可以看到你的进度'))
          .catch(() => undefined);
        return { watchedSha, watchedAt: now, uploadedSha: currentSha, lastUploadAt: now };
      });
    };
    const timer = setInterval(() => void tick(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api, myCopy, pushToast, round.base_version_id, round.id, round.status]);

  async function pickAndSubmit() {
    setSubmitting(true);
    try {
      const picked = await native.pickDocx();
      if (!picked) return;
      if (myCopy && picked.path !== myCopy.localPath) {
        const ok = window.confirm('你选择的文件不是之前下载的工作副本。\n\n确认要提交这份文件吗？');
        if (!ok) return;
      }
      setPending({ name: picked.name, bytes: picked.bytes });
      setNoteOpen(true);
    } catch (e) {
      pushToast('error', '选择文件失败', [e instanceof Error ? e.message : String(e)]);
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmSubmit(note: string) {
    if (!pending) return;
    setSubmitting(true);
    try {
      const result = await api.submit(round.id, round.base_version_id, pending.name, pending.bytes, note);
      pushToast('success', '提交成功，差异已生成', [`状态：${result.status}`]);
      await native.notify('wordwork', `第 ${round.number} 轮提交成功`);
      setNoteOpen(false);
      setPending(null);
      onSubmitted();
    } catch (e) {
      const network = e instanceof ApiError && e.kind === 'network';
      if (network && myCopy) {
        // Snapshot the exact bytes being submitted: the working copy may be
        // re-downloaded or edited again before the network comes back.
        await enqueue({
          roundId: round.id,
          baseVersionId: round.base_version_id,
          note,
          localPath: pending.name,
          bytes: pending.bytes,
        });
        setNoteOpen(false);
        setPending(null);
      } else {
        pushToast('error', '提交失败', [describe(e)]);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>我的工作副本</h2>
          <p>下载本轮基础版本，用 Word 或 WPS 编辑，然后回到这里提交。系统按内容校验版本，不看文件名。</p>
        </div>
      </div>

      {!myCopy ? (
        <EmptyState
          title="还没有下载工作副本"
          hint="点击下方按钮，选择保存位置后即可开始编辑。"
          action={
            <button className="primary" onClick={onDownloaded}>
              下载工作副本
            </button>
          }
        />
      ) : (
        <>
          <div className="doc-line">
            <div>
              <strong>{myCopy.localPath.split(/[\\/]/).pop()}</strong>
              <p>
                基础版本 #{myCopy.baseVersionId} · 更新于 {formatTime(myCopy.updatedAt)}
              </p>
            </div>
            <div className="row-actions">
              <button className="secondary" onClick={() => void native.openWithSystem(myCopy.localPath)}>
                用 Word 打开
              </button>
              <button className="link" onClick={() => void navigator.clipboard?.writeText(myCopy.localPath)}>
                复制路径
              </button>
            </div>
          </div>
          <div className="row-actions">
            <button className="primary" disabled={submitting} onClick={() => void pickAndSubmit()}>
              选择编辑后的文件并提交
            </button>
            <button className="secondary" onClick={onDownloaded}>
              重新下载基础版本
            </button>
            <button className="link" onClick={() => removeWorkingCopy(round.id, round.base_version_id)}>
              忘记这份工作副本
            </button>
          </div>
          {!online && <p className="muted">当前离线：提交会先进入待补传队列，网络恢复后自动上传。</p>}
        </>
      )}

      {noteOpen && pending && (
        <SubmitNoteModal
          filename={pending.name}
          busy={submitting}
          onClose={() => {
            setNoteOpen(false);
            setPending(null);
          }}
          onSubmit={(note) => void confirmSubmit(note)}
        />
      )}
    </section>
  );
}

function SubmitNoteModal({
  filename,
  busy,
  onClose,
  onSubmit,
}: {
  filename: string;
  busy: boolean;
  onClose: () => void;
  onSubmit: (note: string) => void;
}) {
  const [note, setNote] = useState('');
  return (
    <Modal
      title="提交本轮修改"
      onClose={onClose}
      footer={
        <>
          <button className="secondary" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy} onClick={() => onSubmit(note)}>
            {busy ? '提交中…' : '确认提交'}
          </button>
        </>
      }
    >
      <Field label="文件">
        <span className="mono">{filename}</span>
      </Field>
      <Field label="版本说明" hint="简单说明你改了哪些部分，方便老师和同伴审阅。">
        <textarea value={note} rows={3} autoFocus onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}

function ManualMergeModal({
  roundId,
  onClose,
  onDone,
  onError,
}: {
  roundId: number;
  onClose: () => void;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const { api } = useApp();
  const [busy, setBusy] = useState(false);

  async function pick() {
    setBusy(true);
    try {
      const picked = await native.pickDocx();
      if (!picked) {
        setBusy(false);
        return;
      }
      await api.publishManualResult(roundId, picked.name, picked.bytes);
      onDone();
    } catch (e) {
      onError(describe(e));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="上传人工合并结果"
      onClose={onClose}
      footer={
        <>
          <button className="secondary" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy} onClick={() => void pick()}>
            {busy ? '上传中…' : '选择文件并发布'}
          </button>
        </>
      }
    >
      <p>
        在 Word/WPS 中手动整理好最终稿后上传。上传后本轮立即结束，这份文件将成为新的主版本，未决冲突会标记为已人工解决。
      </p>
    </Modal>
  );
}

