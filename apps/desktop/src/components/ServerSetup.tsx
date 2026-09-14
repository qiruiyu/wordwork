import { useState } from 'react';
import { useApp } from '../lib/store';
import { Field } from './ui';

export function ServerSetup({ onCancel, canCancel }: { onCancel?: () => void; canCancel?: boolean }) {
  const { setServerUrl, serverUrl } = useApp();
  const [value, setValue] = useState(serverUrl);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      await setServerUrl(value);
    } catch (e) {
      setError(e instanceof Error ? e.message : '连接失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login-card">
        <span className="logo large">W</span>
        <h1>连接课题组服务器</h1>
        <p>请输入管理员给你的服务器地址。实验室自建的服务器通常形如 https://192.168.1.10:8443。</p>
        <Field label="服务器地址">
          <input
            value={value}
            autoFocus
            placeholder="https://192.168.1.10:8443"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
          />
        </Field>
        {error && <p className="form-error">{error}</p>}
        <button className="primary wide" disabled={busy} onClick={() => void submit()}>
          {busy ? '正在连接…' : '保存并连接'}
        </button>
        {canCancel && (
          <button className="text-btn" onClick={onCancel}>
            返回
          </button>
        )}
      </div>
    </div>
  );
}
