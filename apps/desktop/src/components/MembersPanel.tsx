import { useState } from 'react';
import { useApp } from '../lib/store';
import type { ProjectDetail, Role } from '../types';
import { Field, Modal } from './ui';

export function MembersPanel({
  project,
  isTeacher,
  onChanged,
}: {
  project: ProjectDetail;
  isTeacher: boolean;
  onChanged: () => void;
}) {
  const { api, pushToast } = useApp();
  const [adding, setAdding] = useState(false);

  return (
    <section className="card members">
      <div className="card-head">
        <div>
          <h2>成员管理</h2>
          <p>本项目成员及权限。学生可以提交和查看差异，但不能接受、拒绝、恢复或发布版本。</p>
        </div>
        {isTeacher && (
          <button className="primary" onClick={() => setAdding(true)}>
            添加成员
          </button>
        )}
      </div>
      {project.members.map((m) => (
        <div className="member-row big" key={m.id}>
          <span className="avatar">{m.username[0]?.toUpperCase()}</span>
          <span>
            <strong>{m.username}</strong>
            <small>
              {m.role === 'teacher'
                ? '可审阅、发布与恢复版本'
                : '可提交修改并只读查看他人差异'}
            </small>
          </span>
          <em>{m.role === 'teacher' ? '老师' : '学生'}</em>
        </div>
      ))}
      {adding && (
        <AddMemberModal
          projectId={project.id}
          onClose={() => setAdding(false)}
          onDone={(name) => {
            setAdding(false);
            pushToast('success', `已添加成员 ${name}`);
            onChanged();
          }}
          onError={(message) => pushToast('error', '添加成员失败', [message])}
          api={api}
        />
      )}
    </section>
  );
}

function AddMemberModal({
  projectId,
  onClose,
  onDone,
  onError,
  api,
}: {
  projectId: number;
  onClose: () => void;
  onDone: (username: string) => void;
  onError: (message: string) => void;
  api: ReturnType<typeof useApp>['api'];
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('student');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!username.trim() || password.length < 8) {
      onError('用户名不能为空，初始密码至少 8 位');
      return;
    }
    setBusy(true);
    try {
      await api.addMember(projectId, username.trim(), password, role);
      onDone(username.trim());
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="添加项目成员"
      onClose={onClose}
      footer={
        <>
          <button className="secondary" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy} onClick={() => void submit()}>
            {busy ? '提交中…' : '添加'}
          </button>
        </>
      }
    >
      <Field label="用户名">
        <input value={username} autoFocus onChange={(e) => setUsername(e.target.value)} />
      </Field>
      <Field label="初始密码" hint="至少 8 位。请把用户名和密码单独告知成员，建议首次登录后修改。">
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <Field label="角色">
        <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="student">学生</option>
          <option value="teacher">老师</option>
        </select>
      </Field>
    </Modal>
  );
}
