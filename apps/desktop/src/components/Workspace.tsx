import { useCallback, useEffect, useState } from 'react';
import { useApp } from '../lib/store';
import { ApiError } from '../lib/api';
import type { ProjectSummary } from '../types';
import { ProjectPage } from './ProjectPage';
import { RoundPage } from './RoundPage';
import { ServerSetup } from './ServerSetup';
import { Banner, EmptyState, ErrorState, Spinner } from './ui';

export type Route =
  | { name: 'projects' }
  | { name: 'project'; projectId: number; tab: ProjectTab }
  | { name: 'round'; projectId: number; roundId: number };

export type ProjectTab = 'overview' | 'rounds' | 'members' | 'versions';

export function Workspace() {
  const {
    api,
    member,
    signOut,
    queue,
    online,
    flushQueue,
    pushToast,
    engineWarning,
    orphanedCount,
    clearOrphaned,
  } = useApp();
  const [route, setRoute] = useState<Route>({ name: 'projects' });
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [showServer, setShowServer] = useState(false);
  const [flushBusy, setFlushBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setProjects(await api.listProjects());
    } catch (e) {
      setError(e);
      setProjects([]);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createProject() {
    const name = newName.trim();
    if (!name) return;
    try {
      const created = await api.createProject(name);
      setNewName('');
      setCreating(false);
      pushToast('success', `项目「${created.name}」已创建`);
      await load();
      setRoute({ name: 'project', projectId: created.id, tab: 'overview' });
    } catch (e) {
      pushToast('error', '创建项目失败', [e instanceof Error ? e.message : String(e)]);
    }
  }

  if (showServer) return <ServerSetup canCancel onCancel={() => setShowServer(false)} />;

  const isTeacher = member?.role === 'teacher';

  return (
    <div className="app">
      <aside>
        <div className="brand">
          <span className="logo">W</span>
          <span>wordwork</span>
        </div>
        <div className="workspace">
          {member?.username} <span>{isTeacher ? '老师' : '学生'}</span>
        </div>
        <nav>
          <button
            className={route.name === 'projects' ? 'active' : ''}
            onClick={() => setRoute({ name: 'projects' })}
          >
            <i>▦</i>项目列表
          </button>
        </nav>
        <div className="aside-bottom">
          {queue.length > 0 && (
            <button
              onClick={async () => {
                setFlushBusy(true);
                const sent = await flushQueue();
                setFlushBusy(false);
                if (sent === 0) pushToast('error', '仍无法连接服务器，稍后会自动重试');
              }}
            >
              待补传提交 <b>{queue.length}</b>
            </button>
          )}
          <button onClick={() => setShowServer(true)}>服务器地址</button>
          <button onClick={() => void signOut()}>退出登录</button>
        </div>
      </aside>

      <main>
        <header>
          <div>
            <small>{route.name === 'projects' ? '我的课题组' : '项目'}</small>
            <h1>
              {route.name === 'projects'
                ? '项目列表'
                : route.name === 'project'
                  ? projects?.find((p) => p.id === route.projectId)?.name ?? '项目'
                  : '协作轮次'}
            </h1>
          </div>
          <div className="header-actions">
            {!online && <span className="pill red">离线</span>}
            <span className="avatar">{member?.username?.[0]?.toUpperCase() ?? '?'}</span>
            <span>
              {member?.username} <em>{isTeacher ? '老师' : '学生'}</em>
            </span>
          </div>
        </header>

        {engineWarning && (
          <Banner tone="error" title="服务器组件版本不匹配">
            {engineWarning}
          </Banner>
        )}

        {orphanedCount > 0 && (
          <Banner tone="warn" title={`有 ${orphanedCount} 项旧版本遗留的本地数据已被隔离`}>
            <p>
              这是升级前留下的「工作副本 / 待补传提交」。旧版本没有记录它们属于哪个账号，所以系统不会把它们当成
              你的文件，也<strong>不会</strong>自动上传。请重新下载工作副本并重新提交。
            </p>
            <div className="row-actions">
              <button className="secondary" onClick={clearOrphaned}>
                清除这些旧数据
              </button>
            </div>
          </Banner>
        )}

        {queue.length > 0 && (
          <Banner tone="warn" title={`有 ${queue.length} 份提交等待补传`}>
            网络恢复后会按顺序自动上传；也可以点击左侧「待补传提交」立即重试。
            {flushBusy && ' 正在补传…'}
          </Banner>
        )}

        {route.name === 'projects' && (
          <>
            {isTeacher && (
              <section className="card toolbar-card">
                {creating ? (
                  <div className="inline-form">
                    <input
                      autoFocus
                      value={newName}
                      placeholder="项目名称，例如 2026 国自然申请"
                      onChange={(e) => setNewName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void createProject();
                      }}
                    />
                    <button className="primary" onClick={() => void createProject()}>
                      创建
                    </button>
                    <button className="secondary" onClick={() => setCreating(false)}>
                      取消
                    </button>
                  </div>
                ) : (
                  <button className="primary" onClick={() => setCreating(true)}>
                    ＋ 新建项目
                  </button>
                )}
              </section>
            )}

            {projects === null ? (
              <Spinner />
            ) : error ? (
              <ErrorState message={describe(error)} detail={detailOf(error)} onRetry={() => void load()} />
            ) : projects.length === 0 ? (
              <EmptyState
                title="还没有项目"
                hint={isTeacher ? '点击「新建项目」开始创建课题组项目。' : '请联系老师把你加入项目。'}
              />
            ) : (
              <div className="card-list">
                {projects.map((project) => (
                  <button
                    key={project.id}
                    className="project-row"
                    onClick={() => setRoute({ name: 'project', projectId: project.id, tab: 'overview' })}
                  >
                    <div>
                      <strong>{project.name}</strong>
                      <p>
                        {project.documents} 份文档 · {project.members} 位成员
                        {project.active_round_number ? ` · 第 ${project.active_round_number} 轮进行中` : ''}
                      </p>
                    </div>
                    <span className="chev">›</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {route.name === 'project' && (
          <ProjectPage
            projectId={route.projectId}
            tab={route.tab}
            onTab={(tab) => setRoute({ name: 'project', projectId: route.projectId, tab })}
            onOpenRound={(roundId) => setRoute({ name: 'round', projectId: route.projectId, roundId })}
            onProjectsChanged={() => void load()}
          />
        )}

        {route.name === 'round' && (
          <RoundPage
            roundId={route.roundId}
            onBack={() => setRoute({ name: 'project', projectId: route.projectId, tab: 'rounds' })}
            onChanged={() => void load()}
          />
        )}
      </main>
    </div>
  );
}

export function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return '发生未知错误';
}

export function detailOf(error: unknown): string[] | undefined {
  if (error instanceof ApiError) {
    const lines = error.detailLines;
    return lines.length ? lines : undefined;
  }
  return undefined;
}
