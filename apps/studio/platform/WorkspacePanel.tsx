import { useEffect, useState } from 'react';
import type { WorkspaceStatus } from '../shared/workspace';
import { api, errorMessage } from '../src/api';
import { t, type Message } from '../src/i18n';
import { useSignals } from '../src/reactivity';

export function WorkspacePanel() {
  useSignals();
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [message, setMessage] = useState('docs(content): update content');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message>('');
  const [notice, setNotice] = useState('');
  useEffect(() => { let active = true; api<WorkspaceStatus>('/workspace').then(value => { if (active) setStatus(value); }).catch(reason => { if (active) setError(errorMessage(reason)); }); return () => { active = false; }; }, []);
  async function action(kind: 'refresh' | 'commit' | 'sync') {
    setBusy(true); setError(''); setNotice('');
    try {
      setStatus(await api<WorkspaceStatus>(kind === 'refresh' ? '/workspace' : `/workspace/${kind}`, kind === 'refresh' ? 'GET' : 'POST', kind === 'commit' ? { message } : undefined));
      if (kind === 'commit') setNotice('已提交到设备，尚未推送到远端。');
      if (kind === 'sync') setNotice('已与 Git 远端同步；网站上线状态请以部署平台为准。');
    } catch (reason) { setError(errorMessage(reason)); try { setStatus(await api('/workspace')); } catch { /* Keep the last known status. */ } }
    finally { setBusy(false); }
  }
  return <section className="settings-page workspace-panel">
    <div className="page-heading"><div><h1>{t('工作区同步')}</h1></div><button disabled={busy} onClick={() => void action('refresh')}>{t('刷新状态')}</button></div>
    {error && <p role="alert" className="notice error">{t(error)}</p>}{notice && <p role="status" className="notice success">{t(notice)}</p>}
    <div className="card workspace-sync-card"><h2>{status?.branch || t('正在读取内容…')}</h2>
      {status && <><dl className="workspace-status-grid"><div><dt>{t('本地修改')}</dt><dd>{status.changes}</dd></div><div><dt>{t('待推送提交')}</dt><dd>{status.ahead}</dd></div><div><dt>{t('远端新提交（上次获取）')}</dt><dd>{status.behind}</dd></div></dl>
        {status.diverged && <p className="notice error">{t('双方都有新提交。请先在 Git 工具中合并，本地内容会保留。')}</p>}
        <label className="field"><span>{t('提交说明')}</span><input value={message} maxLength={500} onChange={event => setMessage(event.target.value)} /></label>
        {status.canSync === false && <p className="muted small">{t('App 同步需要 HTTPS 远端；本地保存和提交仍可使用')}</p>}
        <div className="row workspace-sync-actions"><button className="primary" disabled={busy || !status.dirty || !message.trim()} onClick={() => void action('commit')}>{t('提交到设备')}</button><button className="secondary" disabled={busy || status.dirty || status.diverged || status.canSync === false} onClick={() => void action('sync')}>{busy ? t('处理中…') : t('同步 Git')}</button></div>
        </>}
    </div>
  </section>;
}
