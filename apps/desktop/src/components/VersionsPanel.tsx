import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../lib/store';
import * as native from '../lib/native';
import type { ProjectDetail, VersionSummary } from '../types';
import { isRestorableVersion } from '../lib/format';
import { EmptyState, ErrorState, KIND_LABELS, Spinner, formatBytes, formatTime } from './ui';
import { describe } from './Workspace';

export function VersionsPanel({
  project,
  isTeacher,
  onChanged,
}: {
  project: ProjectDetail;
  isTeacher: boolean;
  onChanged: () => void;
}) {
  const { api, pushToast } = useApp();
  const [documentId, setDocumentId] = useState<number | null>(project.documents[0]?.id ?? null);
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<number | null>(null);

  // Keep the selection valid when the project reloads (documents added or removed).
  useEffect(() => {
    if (documentId === null || !project.documents.some((d) => d.id === documentId)) {
      setDocumentId(project.documents[0]?.id ?? null);
    }
  }, [documentId, project.documents]);

  const load = useCallback(async () => {
    if (!documentId) {
      setVersions([]);
      return;
    }
    setError(null);
    try {
      setVersions(await api.listVersions(documentId));
    } catch (e) {
      setError(e);
      setVersions([]);
    }
  }, [api, documentId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function download(version: VersionSummary) {
    setBusy(version.id);
    try {
      const { bytes, filename } = await api.downloadVersion(version.id);
      const target = await native.pickSavePath(filename);
      if (!target) return;
      // Overwriting a file Word/WPS still has open produces a truncated .docx.
      const problem = await native.saveDocument(target, bytes);
      if (problem) {
        pushToast('error', '无法保存下载文件', [problem]);
        return;
      }
      pushToast('success', `已下载到 ${target}`);
    } catch (e) {
      pushToast('error', '下载失败', [e instanceof Error ? e.message : String(e)]);
    } finally {
      setBusy(null);
    }
  }

  async function restore(version: VersionSummary) {
    if (!documentId) return;
    setBusy(version.id);
    try {
      await api.restoreVersion(version.id, documentId);
      pushToast('success', `已把版本 #${version.id} 恢复为当前主版本`);
      await load();
      onChanged();
    } catch (e) {
      pushToast('error', '恢复失败', [e instanceof Error ? e.message : String(e)]);
    } finally {
      setBusy(null);
    }
  }

  if (project.documents.length === 0) {
    return (
      <section className="card">
        <EmptyState title="还没有文档" hint="上传初始 DOCX 之后才会产生版本历史。" />
      </section>
    );
  }

  return (
    <section className="card versions">
      <div className="card-head">
        <div>
          <h2>版本历史</h2>
          <p>所有版本均为不可变快照，可随时下载{isTeacher ? '或恢复' : ''}。</p>
        </div>
        {project.documents.length > 1 && (
          <select value={documentId ?? ''} onChange={(e) => setDocumentId(Number(e.target.value))}>
            {project.documents.map((doc) => (
              <option key={doc.id} value={doc.id}>
                {doc.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {versions === null ? (
        <Spinner />
      ) : error ? (
        <ErrorState message={describe(error)} onRetry={() => void load()} />
      ) : versions.length === 0 ? (
        <EmptyState title="暂无版本记录" />
      ) : (
        versions.map((version) => (
          <div className="version-row" key={version.id}>
            <span className="timeline">{version.current ? '●' : '○'}</span>
            <div>
              <strong>
                {KIND_LABELS[version.kind] ?? version.kind}
                {version.current && <span className="pill green current-tag">当前主版本</span>}
              </strong>
              <p>
                {version.author ?? '系统'} · {formatTime(version.created_at)} · {formatBytes(version.size_bytes)}
              </p>
              <code>{version.display_name}</code>
            </div>
            <div className="row-actions">
              <button className="link" disabled={busy === version.id} onClick={() => void download(version)}>
                下载
              </button>
              {isTeacher && !version.current && isRestorableVersion(version.kind) && (
                <button className="secondary" disabled={busy === version.id} onClick={() => void restore(version)}>
                  恢复
                </button>
              )}
              {isTeacher && !version.current && !isRestorableVersion(version.kind) && (
                // Say why there is no 恢复 button instead of leaving its absence to be
                // guessed at; the server refuses these kinds too.
                <span className="muted">审阅用中间版本，不可恢复</span>
              )}
            </div>
          </div>
        ))
      )}
    </section>
  );
}
