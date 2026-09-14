import { useEffect, useState } from 'react';
import { AppProvider, useApp } from './lib/store';
import { Login } from './components/Login';
import { ServerSetup } from './components/ServerSetup';
import { Workspace } from './components/Workspace';
import { Field, Modal, Spinner } from './components/ui';

export default function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}

function Shell() {
  const { ready, serverUrl, session, toasts, dismissToast, member } = useApp();
  const [editingServer, setEditingServer] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);

  useEffect(() => {
    if (member?.must_change_password) setPasswordOpen(true);
  }, [member?.must_change_password]);

  return (
    <>
      {!ready ? (
        <div className="boot">
          <Spinner label="正在启动 wordwork…" />
        </div>
      ) : editingServer || !serverUrl ? (
        <ServerSetup canCancel={Boolean(serverUrl)} onCancel={() => setEditingServer(false)} />
      ) : !session ? (
        <Login onEditServer={() => setEditingServer(true)} />
      ) : (
        <Workspace />
      )}

      {session && passwordOpen && <ChangePasswordModal onClose={() => setPasswordOpen(false)} />}

      <div className="toasts">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone}`}>
            <div>
              <strong>{toast.text}</strong>
              {toast.detail?.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
            <button className="icon-btn" onClick={() => dismissToast(toast.id)} aria-label="关闭">
              ×
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const { changePassword, member, signOut } = useApp();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (next.length < 8) {
      setError('新密码至少 8 位');
      return;
    }
    if (next !== repeat) {
      setError('两次输入的新密码不一致');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await changePassword(current, next);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : '修改密码失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    // Not dismissible on purpose: the server refuses every other request (428) until
    // the initial password is changed, so offering "稍后再说" would only lead the user
    // into a UI where nothing works. Signing out is the single escape hatch.
    <Modal
      title="请修改初始密码"
      dismissible={false}
      onClose={onClose}
      footer={
        <>
          <button className="secondary" disabled={busy} onClick={() => void signOut()}>
            退出登录
          </button>
          <button className="primary" disabled={busy} onClick={() => void submit()}>
            {busy ? '提交中…' : '修改密码'}
          </button>
        </>
      }
    >
      <p>
        账号 <strong>{member?.username}</strong> 正在使用初始密码。初始密码由管理员或老师告知，<strong>必须修改后才能使用其他功能</strong>。
      </p>
      <Field label="当前密码">
        <input type="password" value={current} autoFocus onChange={(e) => setCurrent(e.target.value)} />
      </Field>
      <Field label="新密码" hint="至少 8 位。">
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label="再次输入新密码">
        <input
          type="password"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
        />
      </Field>
      {error && <p className="form-error">{error}</p>}
    </Modal>
  );
}
