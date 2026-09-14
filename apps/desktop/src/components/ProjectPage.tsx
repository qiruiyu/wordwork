import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../lib/store';
import { ApiError } from '../lib/api';
import * as native from '../lib/native';
import type { ProjectDetail, RoundSummary } from '../types';
import { MembersPanel } from './MembersPanel';
import { VersionsPanel } from './VersionsPanel';
import type { ProjectTab } from './Workspace';
import { describe, detailOf } from './Workspace';
import { Banner, EmptyState, ErrorState, Field, Modal, Spinner, StatusPill, formatTime } from './ui';

export function ProjectPage({
  projectId,
  tab,
  onTab,
  onOpenRound,
  onProjectsChanged,
}: {
  projectId: number;
  tab: ProjectTab;
  onTab: (tab: ProjectTab) => void;
  onOpenRound: (roundId: number) => void;
  onProjectsChanged: () => void;
}) {
  const { api, member, pushToast } = useApp();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [rounds, setRounds] = useState<RoundSummary[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  const isTeacher = member?.role === 'teacher';

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [detail, roundList] = await Promise.all([api.getProject(projectId), api.listRounds(projectId)]);
      setProject(detail);
      setRounds(roundList);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [api, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Only the *first* load shows the full-page spinner. A refresh triggered by an
  // incoming event would otherwise unmount everything below (version list included)
  // and rebuild it, which reads as a flicker.
  if (loading && !project) return <Spinner />;
  if (error) return <ErrorState message={describe(error)} detail={detailOf(error)} onRetry={() => void load()} />;
  if (!project) return null;

  const tabs: Array<[ProjectTab, string]> = [
    ['overview', '项目概览'],
    ['rounds', '协作轮次'],
    ['versions', '版本历史'],
    ['members', '成员管理'],
  ];

  return (
    <>
      <div className="tabs">
        {tabs.map(([id, label]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => onTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <Overview
          project={project}
          rounds={rounds}
          isTeacher={isTeacher}
          onChanged={() => {
            void load();
            onProjectsChanged();
          }}
          onOpenRound={onOpenRound}
          pushToast={pushToast}
        />
      )}

      {tab === 'rounds' && (
        <section className="card">
          <div className="card-head">
            <div>
              <h2>协作轮次</h2>
              <p>每一轮都冻结一个基础版本，成员基于它提交修改。</p>
            </div>
          </div>
          {rounds.length === 0 ? (
            <EmptyState title="还没有协作轮次" hint={isTeacher ? '在「项目概览」中上传文档并发布新一轮。' : '等待老师发布轮次。'} />
          ) : (
            rounds.map((round) => (
              <div className="version-row" key={round.id}>
                <span className="timeline">●</span>
                <div>
                  <strong>第 {round.number} 轮</strong>
                  <p>
                    {formatTime(round.created_at)} · {round.submission_count} 份提交
                  </p>
                </div>
                <div className="row-actions">
                  <StatusPill status={round.status} />
                  <button className="link" onClick={() => onOpenRound(round.id)}>
                    打开
                  </button>
                </div>
              </div>
            ))
          )}
        </section>
      )}

      {tab === 'versions' && <VersionsPanel project={project} isTeacher={isTeacher} onChanged={() => void load()} />}

      {tab === 'members' && (
        <MembersPanel project={project} isTeacher={isTeacher} onChanged={() => void load()} />
      )}
    </>
  );
}

function Overview({
  project,
  rounds,
  isTeacher,
  onChanged,
  onOpenRound,
  pushToast,
}: {
  project: ProjectDetail;
  rounds: RoundSummary[];
  isTeacher: boolean;
  onChanged: () => void;
  onOpenRound: (roundId: number) => void;
  pushToast: (tone: 'info' | 'success' | 'error', text: string, detail?: string[]) => void;
}) {
  const { api } = useApp();
  const [busy, setBusy] = useState('');
  const [uploadTarget, setUploadTarget] = useState<number | null>(null);
  // Which document a new round is cut from. Defaulting to the first document is a
  // convenience, but the teacher has to be able to see and change it: with more than
  // one document in a project, silently binding every new round to documents[0] is
  // how contributions end up attached to the wrong file.
  const [selectedDocumentId, setSelectedDocumentId] = useState<number | null>(project.documents[0]?.id ?? null);

  useEffect(() => {
    if (selectedDocumentId === null || !project.documents.some((d) => d.id === selectedDocumentId)) {
      setSelectedDocumentId(project.documents[0]?.id ?? null);
    }
  }, [project.documents, selectedDocumentId]);

  const openRound = rounds.find((r) => r.status === 'open') ?? null;
  const draftRound = rounds.find((r) => r.status === 'draft') ?? null;
  const selectedDocument = project.documents.find((d) => d.id === selectedDocumentId) ?? null;

  async function uploadInitial() {
    if (!isTeacher) return;
    const picked = await native.pickDocx();
    if (!picked) return;
    setBusy('upload');
    try {
      await api.uploadDocument(project.id, picked.name, picked.bytes);
      pushToast('success', `已上传初始文档：${picked.name}`);
      onChanged();
    } catch (e) {
      pushToast('error', '上传失败', [e instanceof Error ? e.message : String(e)]);
    } finally {
      setBusy('');
    }
  }

  async function restoreAsMaster(documentId: number, versionId: number, label: string) {
    setBusy('restore');
    try {
      await api.restoreVersion(versionId, documentId);
      pushToast('success', `已把 ${label} 设为当前主版本`);
      onChanged();
    } catch (e) {
      pushToast('error', '恢复失败', [e instanceof Error ? e.message : String(e)]);
    } finally {
      setBusy('');
    }
  }

  async function startRound() {
    if (!project.documents.length || selectedDocumentId === null) {
      pushToast('error', '请先上传一份初始文档');
      return;
    }
    setBusy('round');
    try {
      const created = await api.createRound(project.id, selectedDocumentId);
      await api.publishRound(created.id);
      pushToast('success', `第 ${created.number} 轮已发布，成员现在可以下载工作副本`, [
        `本轮基于《${selectedDocument?.name ?? selectedDocumentId}》`,
      ]);
      onChanged();
    } catch (e) {
      pushToast('error', '发布轮次失败', [e instanceof Error ? e.message : String(e)]);
    } finally {
      setBusy('');
    }
  }

  async function publishDraft(roundId: number, number: number) {
    setBusy('publish');
    try {
      await api.publishRound(roundId);
      pushToast('success', `第 ${number} 轮已发布`);
      onChanged();
    } catch (e) {
      pushToast('error', '发布失败', [e instanceof Error ? e.message : String(e)]);
    } finally {
      setBusy('');
    }
  }

  const unreadableError = (e: unknown) =>
    e instanceof ApiError && e.kind === 'forbidden' ? '你没有执行该操作的权限' : String(e);

  return (
    <>
      {isTeacher && !openRound && !draftRound && (
        <Banner tone="info" title="准备新一轮协作">
          上传初始 DOCX 后点击「发布新一轮」。成员将下载到完全相同的副本，并在编辑后提交。
        </Banner>
      )}

      <section className="hero">
        <div>
          <span className="eyebrow">课题项目</span>
          <h2>{project.name}</h2>
          <p>
            创建于 {formatTime(project.created_at)} · {project.members.length} 位成员 ·{' '}
            {project.documents.length} 份文档
          </p>
        </div>
        {isTeacher &&
          (draftRound ? (
            <button
              className="primary"
              disabled={busy !== ''}
              onClick={() => void publishDraft(draftRound.id, draftRound.number)}
            >
              发布第 {draftRound.number} 轮
            </button>
          ) : (
            <button className="primary" disabled={busy !== ''} onClick={() => void startRound()}>
              ＋ 发布新一轮
            </button>
          ))}
      </section>

      <div className="grid">
        <section className="card">
          <div className="card-head">
            <div>
              <span className="file-icon">W</span>
              <div>
                <h3>{selectedDocument?.name ?? '尚未上传文档'}</h3>
                <p>
                  {project.documents.length > 1
                    ? '选择用于下一轮协作的文档'
                    : project.documents.length
                      ? '项目主文档'
                      : '还没有主文档'}
                </p>
              </div>
            </div>
            {project.documents.length > 1 && (
              <select
                value={selectedDocumentId ?? ''}
                onChange={(e) => setSelectedDocumentId(Number(e.target.value))}
              >
                {project.documents.map((doc) => (
                  <option key={doc.id} value={doc.id}>
                    {doc.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          {project.documents.length === 0 ? (
            <EmptyState
              title="还没有初始文档"
              hint={isTeacher ? '上传一份 .docx 作为本轮协作的起点。' : '等待老师上传初始文档。'}
              action={
                isTeacher ? (
                  <button className="primary" disabled={busy !== ''} onClick={() => void uploadInitial()}>
                    选择并上传 .docx
                  </button>
                ) : undefined
              }
            />
          ) : (
            <div className="stack">
              {project.documents.map((doc) => (
                <div className="doc-line" key={doc.id}>
                  <div>
                    <strong>
                      {doc.name}
                      {doc.id === selectedDocumentId && project.documents.length > 1 && (
                        <span className="pill blue">下一轮用它</span>
                      )}
                    </strong>
                    <p>当前主版本 #{doc.current_version_id ?? '—'}</p>
                  </div>
                  {isTeacher && (
                    <div className="row-actions">
                      <button className="secondary" disabled={busy !== ''} onClick={() => setUploadTarget(doc.id)}>
                        替换主文档
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {isTeacher && (
                <button className="secondary" disabled={busy !== ''} onClick={() => void uploadInitial()}>
                  上传新的 DOCX
                </button>
              )}
            </div>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h3>当前轮次</h3>
            {openRound ? <StatusPill status={openRound.status} /> : <span className="pill grey">无进行中轮次</span>}
          </div>
          {openRound ? (
            <>
              <p className="muted">
                第 {openRound.number} 轮 · {openRound.submission_count} 份提交 · {formatTime(openRound.created_at)}
              </p>
              <button className="primary" onClick={() => onOpenRound(openRound.id)}>
                进入本轮
              </button>
            </>
          ) : (
            <EmptyState
              title="当前没有进行中的轮次"
              hint={isTeacher ? '发布新一轮后，成员即可开始协作。' : '等待老师发布新一轮。'}
            />
          )}
        </section>
      </div>

      {uploadTarget !== null && (
        <ReplaceDocumentModal
          documentId={uploadTarget}
          onClose={() => setUploadTarget(null)}
          onDone={() => {
            setUploadTarget(null);
            onChanged();
          }}
          onError={(e) => pushToast('error', '上传失败', [unreadableError(e)])}
        />
      )}
    </>
  );
}

function ReplaceDocumentModal({
  documentId,
  onClose,
  onDone,
  onError,
}: {
  documentId: number;
  onClose: () => void;
  onDone: () => void;
  onError: (e: unknown) => void;
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
      // Adds a version to *this* document. Uploading a new document instead would
      // leave every existing round pointing at the old file.
      await api.replaceDocumentVersion(documentId, picked.name, picked.bytes);
      onDone();
    } catch (e) {
      onError(e);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="替换主文档"
      onClose={onClose}
      footer={
        <>
          <button className="secondary" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy} onClick={() => void pick()}>
            {busy ? '上传中…' : '选择文件并上传'}
          </button>
        </>
      }
    >
      <Field
        label="说明"
        hint="仅支持未加密、不含宏的 .docx，最大 100 MB。上传后当前主版本会更新为一个新的不可变版本；已发布的轮次不受影响。"
      >
        <span />
      </Field>
    </Modal>
  );
}
