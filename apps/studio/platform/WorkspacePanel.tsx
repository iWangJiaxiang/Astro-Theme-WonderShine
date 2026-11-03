import { useEffect, useState } from 'react';
import { workspaceCommitNotice } from './workspace-notice';
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
  const [pending, setPending] = useState<'commit' | 'sync' | 'commit-sync' | null>(null);
  async function action(kind: 'refresh' | 'commit' | 'sync' | 'commit-sync') {
    setBusy(true); setError(''); setNotice('');
    let committed = false;
    try {
      let current = status;
      if (kind === 'refresh') current = await api<WorkspaceStatus>('/workspace');
      else {
        if (!current?.confirmation) throw new Error('工作区已变化，请刷新并重新确认提交范围');
        if (kind === 'commit' || kind === 'commit-sync') {
          current = await api<WorkspaceStatus>('/workspace/commit', 'POST', { message, confirmation: current.confirmation });
          setStatus(current);
          committed = true;
          setNotice(workspaceCommitNotice(kind === 'commit-sync' ? 'pending' : 'none'));
        }
        if (kind === 'sync' || kind === 'commit-sync') {
          current = await api<WorkspaceStatus>('/workspace/sync', 'POST', { confirmation: current.confirmation });
          setNotice('已与 Git 远端同步；网站上线状态请以部署平台为准。');
        }
      }
      setStatus(current);
      if (kind === 'commit') setNotice('已提交到设备，尚未推送到远端。');
      if (kind === 'sync') setNotice('已与 Git 远端同步；网站上线状态请以部署平台为准。');
    } catch (reason) {
      if (committed && kind === 'commit-sync') setNotice(workspaceCommitNotice('unconfirmed'));
      setError(errorMessage(reason));
      try { setStatus(await api('/workspace')); } catch { /* Keep the last known status; it cannot confirm a remote outcome. */ }
    }
    finally { setBusy(false); setPending(null); }
  }
  return <section className="settings-page workspace-panel">
    <div className="page-heading"><div><h1>{t('工作区同步')}</h1></div><button disabled={busy || !!pending} onClick={() => void action('refresh')}>{t('刷新状态')}</button></div>
    {error && <p role="alert" className="notice error">{t(error)}</p>}{notice && <p role="status" className="notice success">{t(notice)}</p>}
    <div className="card workspace-sync-card"><h2>{status?.branch || t('正在读取内容…')}</h2>
      {status && <><dl className="workspace-status-grid"><div><dt>{t('本地修改')}</dt><dd>{status.changes}</dd></div><div><dt>{t('待推送提交')}</dt><dd>{status.ahead}</dd></div><div><dt>{t('远端新提交（上次获取）')}</dt><dd>{status.behind}</dd></div></dl>
        {status.diverged && <p className="notice error">{t('双方都有新提交。请先在 Git 工具中合并，本地内容会保留。')}</p>}
        <label className="field"><span>{t('提交说明')}</span><input disabled={busy || !!pending} value={message} maxLength={500} onChange={event => setMessage(event.target.value)} /></label>
        {status.canSync === false && <p className="muted small">{t('App 同步需要 HTTPS 远端；本地保存和提交仍可使用')}</p>}
        <h3>{t('本次托管文件范围')}</h3>
        <ul>{status.managedChanges?.map(path => <li key={path}><code>{path}</code></li>)}</ul>
        <p className="muted small">{t('只包含已保存的托管文件，可能包含其他文章和草稿。同步会推送当前分支已有提交，不推送保存分支，也不代表网站已部署。')}</p>
        {status.changes !== status.managedChanges?.length && <p className="notice error">{t('存在托管范围以外的修改，请先在 Git 工具中处理再同步。')}</p>}
        <div className="row workspace-sync-actions"><button className="primary" disabled={busy || !!pending || !status.confirmation || !status.managedChanges?.length || !message.trim()} onClick={() => setPending('commit')}>{t('提交到设备')}</button><button className="secondary" disabled={busy || !!pending || !status.confirmation || status.dirty || status.diverged || status.canSync === false} onClick={() => setPending('sync')}>{t('同步 Git')}</button><button className="primary" disabled={busy || !!pending || !status.confirmation || !status.managedChanges?.length || status.changes !== status.managedChanges.length || !message.trim() || status.diverged || status.canSync === false} onClick={() => setPending('commit-sync')}>{t('提交并同步')}</button></div>
        {pending && <div role="group" aria-label={t('确认 Git 操作')} className="notice">
          <p>{t('确认 Git 操作')}：<strong>{status.branch}</strong> — {t(pending === 'commit' ? '提交到设备' : pending === 'sync' ? '同步 Git' : '提交并同步')}</p>
          <p>{t('请核对以上文件范围与待推送提交。未保存的编辑不会包含在内；失败时本地文件和提交会保留。')}</p>
          <button disabled={busy} onClick={() => void action(pending)}>{busy ? t('处理中…') : t('确认执行')}</button>
          <button disabled={busy} onClick={() => setPending(null)}>{t('取消')}</button>
        </div>}
        </>}
    </div>
  </section>;
}
