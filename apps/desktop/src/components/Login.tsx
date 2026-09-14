import { useState } from 'react';
import { useApp } from '../lib/store';
import { Field } from './ui';

export function Login({ onEditServer }: { onEditServer: () => void }) {
  const { signIn, serverUrl } = useApp();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!username.trim() || !password) {
      setError('请填写用户名和密码');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await signIn(username.trim(), password);
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login-card">
        <span className="logo large">W</span>
        <h1>欢迎回到 wordwork</h1>
        <p>让每一次修改，都清晰可追溯。</p>
        <Field label="用户名">
          <input
            value={username}
            autoFocus
            autoComplete="username"
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field label="密码">
          <input
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
          />
        </Field>
        {error && <p className="form-error">{error}</p>}
        <button className="primary wide" disabled={busy} onClick={() => void submit()}>
          {busy ? '正在登录…' : '登录'}
        </button>
        <p className="server-hint">
          服务器：<code>{serverUrl}</code>{' '}
          <button className="link" onClick={onEditServer}>
            修改
          </button>
        </p>
      </div>
    </div>
  );
}
