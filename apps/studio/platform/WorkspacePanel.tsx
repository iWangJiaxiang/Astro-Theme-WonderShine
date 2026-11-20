import { useEffect, useRef, useState } from 'react';
import { workspaceCommitNotice } from './workspace-notice';
import type { WorkspaceStatus } from '../shared/workspace';
import { nativeGitCredential } from './git-credential';
import { api, errorMessage, session } from '../src/api';
import { t, type Message } from '../src/i18n';
import { useSignals } from '../src/reactivity';
import { notifyWorkspaceChanged } from '../src/workspace-events';

export function WorkspacePanel({ publishPath, onClose }: { publishPath?: string; onClose?: (pushed: boolean) => void } = {}) {
  useSignals();
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [message, setMessage] = useState('docs(content): update content');
  const [stage, setStage] = useState('正在检查工作区…');
  const busy = !!stage;
  const [error, setError] = useState<Message>('');
  const [notice, setNotice] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const tokenInput = useRef<HTMLInputElement>(null);
  const [pushed, setPushed] = useState(false);
  const requestSequence = useRef(0);
  useEffect(() => {
    if (publishPath) {
      const node = dialog.current!;
      node.showModal();
      void review('publish');
      return () => { requestSequence.current++; node.close(); };
    }
    let active = true;
    const sequence = ++requestSequence.current;
    api<WorkspaceStatus>('/workspace').then(value => {
      if (active && sequence === requestSequence.current) setStatus(value);
    }).catch(reason => { if (active && sequence === requestSequence.current) setError(errorMessage(reason)); })
      .finally(() => { if (active && sequence === requestSequence.current) setStage(''); });
    return () => { active = false; };
  }, [publishPath]);
  const [pending, setPending] = useState<'commit' | 'sync' | 'commit-sync' | null>(null);
  async function review(kind: 'commit' | 'sync' | 'commit-sync' | 'publish') {
    const sequence = ++requestSequence.current;
    setStage('正在检查工作区…'); setError(''); setNotice('');
    try {
      const reviewed = await api<WorkspaceStatus>('/workspace/review', 'POST');
      if (sequence !== requestSequence.current) return;
      if (!reviewed.confirmation) throw new Error('工作区已变化，请刷新并重新确认提交范围');
      setStatus(reviewed);
      setPending(kind === 'publish' ? (reviewed.dirty ? 'commit-sync' : 'sync') : kind);
    } catch (reason) { if (sequence === requestSequence.current) { setError(errorMessage(reason)); setPending(null); } }
    finally { if (sequence === requestSequence.current) setStage(''); }
  }
  async function action(kind: 'refresh' | 'commit' | 'sync' | 'commit-sync') {
    requestSequence.current++;
    setStage(kind === 'sync' ? '正在同步仓库…' : kind === 'refresh' ? '正在检查工作区…' : '正在保存版本…'); setError(''); setNotice('');
    let committed = false, syncing = false, reviewSync = false;
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
        if (kind === 'commit-sync') {
          // A commit changes HEAD. Review that new state visibly, never silently
          // replace the user's original token and push an unreviewed state.
          setStage('正在检查工作区…');
          current = await api<WorkspaceStatus>('/workspace/review', 'POST');
          if (!current.confirmation) throw new Error('工作区已变化，请刷新并重新确认提交范围');
          reviewSync = true;
          setNotice('已提交到设备，尚未推送。请核对提交后的状态，再确认同步 Git。');
        }
        if (kind === 'sync') {
          const credential = nativeGitCredential.current;
          if (credential && credential.id === session.value?.identity.id && tokenInput.current?.value) {
            credential.set(tokenInput.current.value);
            tokenInput.current.value = '';
          }
          syncing = true;
          current = await api<WorkspaceStatus>('/workspace/sync', 'POST', { confirmation: current.confirmation });
          setPushed(true);
        }
      }
      setStatus(current);
      if (kind === 'commit') setNotice('已提交到设备，尚未推送到远端。');
      if (kind === 'sync') setNotice('已与 Git 远端同步；网站上线状态请以部署平台为准。');
    } catch (reason) {
      if (syncing) setNotice(workspaceCommitNotice('unconfirmed'));
      else if (committed && kind === 'commit-sync') setNotice('已提交到设备，尚未推送。请刷新状态后重新确认同步。');
      setError(errorMessage(reason));
      setStatus(null);
    }
    finally {
      if (syncing) notifyWorkspaceChanged();
      setStage(''); setPending(reviewSync ? 'sync' : null);
    }
  }
  if (publishPath) {
    const blocked = status?.canSync === false ? 'App 同步需要 HTTPS 远端；本地保存和提交仍可使用'
      : status?.diverged ? '双方都有新提交。请先在 Git 工具中合并，本地内容会保留。'
      : status && status.changes !== status.managedChanges?.length ? '存在托管范围以外的修改，请先在 Git 工具中处理再同步。'
      : pending === 'sync' && status?.dirty ? '工作区已变化，请刷新并重新确认提交范围' : '';
    return <dialog ref={dialog} className="publish-dialog" aria-labelledby="publish-heading"
      onCancel={event => { event.preventDefault(); if (!busy) onClose?.(pushed); }}>
      <h2 id="publish-heading">{t(pushed ? '动态已发送到仓库' : '发布动态')}</h2>
      {status && pending && !pushed && <>
        <p>{t(pending === 'sync' ? '将 {count} 个已保存版本发送到 {branch}。' : '此版本包含 {count} 个文件，保存到 {branch}。', {
          count: pending === 'sync' ? status.ahead : status.managedChanges?.length || 0, branch: status.branch,
        })}</p>
        {!!status.managedChanges?.length && <details open={status.managedChanges.some(path => path !== publishPath)}>
          <summary>{t('查看文件')}</summary><ul>{status.managedChanges.map(path => <li key={path}>{path}</li>)}</ul>
        </details>}
      </>}
      {notice && (pushed || pending !== 'sync') && <p role="status">{t(pushed ? '网站部署后即可查看。' : notice)}</p>}
      {error && <p className="notice error" role="alert">{t(error)}</p>}
      {blocked && !pushed && <p className="notice error">{t(blocked)}</p>}
      {pending === 'sync' && nativeGitCredential.current && nativeGitCredential.current.id === session.value?.identity.id &&
        <details className="publish-credential"><summary>{t('仓库登录')}</summary>
          <label className="field">{t('访问令牌')}<input ref={tokenInput} type="password" autoComplete="off" placeholder={t('仅当前会话')} /></label>
        </details>}
      <div className="publish-actions">
        {!pushed && <button className="secondary" disabled={busy} onClick={() => onClose?.(false)}>{t('稍后')}</button>}
        {pushed ? <button className="primary" onClick={() => onClose?.(true)}>{t('完成')}</button>
          : <button className="primary" disabled={busy} onClick={() => pending && !blocked ? void action(pending) : void review('publish')}>
            {t(busy ? stage : blocked ? '刷新状态' : !pending ? '重试' : pending === 'sync' ? '确认发布' : '保存此版本')}</button>}
      </div>
    </dialog>;
  }
  return <section className="settings-page workspace-panel">
    <div className="page-heading"><div><h1>{t('工作区同步')}</h1></div><button disabled={busy || !!pending} onClick={() => void action('refresh')}>{t('刷新状态')}</button></div>
    {error && <p role="alert" className="notice error">{t(error)}</p>}{notice && <p role="status" className="notice success">{t(notice)}</p>}
    {busy && <p role="status" className="muted small">{t(stage)}</p>}
    {status && <div className="card workspace-sync-card"><h2>{status.branch}</h2>
      <dl className="workspace-status-grid"><div><dt>{t('本地修改')}</dt><dd>{status.changes}</dd></div><div><dt>{t('待推送提交')}</dt><dd>{status.ahead}</dd></div><div><dt>{t('远端新提交（上次获取）')}</dt><dd>{status.behind}</dd></div></dl>
        {status.diverged && <p className="notice error">{t('双方都有新提交。请先在 Git 工具中合并，本地内容会保留。')}</p>}
        <label className="field"><span>{t('提交说明')}</span><input disabled={busy || !!pending} value={message} maxLength={500} onChange={event => setMessage(event.target.value)} /></label>
        {status.canSync === false && <p className="muted small">{t('App 同步需要 HTTPS 远端；本地保存和提交仍可使用')}</p>}
        <h3>{t('本次托管文件范围')}</h3>
        <ul>{status.managedChanges?.map(path => <li key={path}><code>{path}</code></li>)}</ul>
        <p className="muted small">{t('只包含已保存的托管文件，可能包含其他文章和草稿。同步会推送当前分支已有提交，不推送保存分支，也不代表网站已部署。')}</p>
        {status.changes !== status.managedChanges?.length && <p className="notice error">{t('存在托管范围以外的修改，请先在 Git 工具中处理再同步。')}</p>}
        <div className="row workspace-sync-actions"><button className="primary" disabled={busy || !!pending || !status.managedChanges?.length || !message.trim()} onClick={() => void review('commit')}>{t('提交到设备')}</button><button className="secondary" disabled={busy || !!pending || status.dirty || status.diverged || status.canSync === false} onClick={() => void review('sync')}>{t('同步 Git')}</button><button className="primary" disabled={busy || !!pending || !status.managedChanges?.length || status.changes !== status.managedChanges.length || !message.trim() || status.diverged || status.canSync === false} onClick={() => void review('commit-sync')}>{t('提交并同步')}</button></div>
        {pending && <div role="group" aria-label={t('确认 Git 操作')} className="notice">
          <p>{t('确认 Git 操作')}：<strong>{status.branch}</strong> — {t(pending === 'commit' ? '提交到设备' : pending === 'sync' ? '同步 Git' : '提交并同步')}</p>
          <p>{t('请核对以上文件范围与待推送提交。未保存的编辑不会包含在内；失败时本地文件和提交会保留。')}</p>
          <div className="publish-actions"><button className="primary" disabled={busy} onClick={() => void action(pending)}>{busy ? t('处理中…') : t('确认执行')}</button>
          <button className="secondary" disabled={busy} onClick={() => setPending(null)}>{t('取消')}</button></div>
        </div>}
    </div>}
  </section>;
}
