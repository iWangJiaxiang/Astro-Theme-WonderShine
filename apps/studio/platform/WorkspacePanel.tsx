import { containModalFocus } from '../src/modal-layer';
import { ErrorNotice } from "../src/components/ErrorNotice";
import LoadingState from '../src/components/LoadingState';
import { useEffect, useRef, useState } from 'react';
import { workspaceCommitNotice } from './workspace-notice';
import type { WorkspaceStatus } from '../shared/workspace';
import AccountLogin from './AccountLogin';
import { isGitAuthFailure, nativeGitCredential } from './git-credential';
import { api, errorMessage, session } from '../src/api';
import { t, type Message } from '../src/i18n';
import { useSignals } from '../src/reactivity';
import { notifyWorkspaceChanged } from '../src/workspace-events';

type Operation = 'commit' | 'sync' | 'publish' | 'discard';

export function WorkspacePanel({ publishPath, onClose }: { publishPath?: string; onClose?: (pushed: boolean) => void } = {}) {
  useSignals();
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [message, setMessage] = useState('docs(content): update content');
  const [stage, setStage] = useState('正在检查工作区…');
  const busy = !!stage;
  const [error, setError] = useState<Message>('');
  const [notice, setNotice] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const reviewTrigger = useRef<HTMLElement | null>(null);
  const tokenInput = useRef<HTMLInputElement>(null);
  const [authFailed, setAuthFailed] = useState(false);
  const retryOperation = useRef<'publish' | 'sync'>('sync');
  const [pushed, setPushed] = useState(false);
  const requestSequence = useRef(0);
  useEffect(() => {
    if (publishPath) {
      const node = dialog.current!;
      node.showModal();
      const releaseFocus = containModalFocus(node);
      void review('publish');
      return () => { requestSequence.current++; releaseFocus(); node.close(); };
    }
    let active = true;
    const sequence = ++requestSequence.current;
    api<WorkspaceStatus>('/workspace').then(value => {
      if (active && sequence === requestSequence.current) setStatus(value);
    }).catch(reason => { if (active && sequence === requestSequence.current) setError(errorMessage(reason)); })
      .finally(() => { if (active && sequence === requestSequence.current) setStage(''); });
    return () => { active = false; };
  }, [publishPath]);
  const [pending, setPending] = useState<Operation | null>(null);
  useEffect(() => {
    if (publishPath || !pending) return;
    const node = dialog.current!;
    node.showModal();
    const releaseFocus = containModalFocus(node);
    node.querySelector('h2')?.focus();
    return () => {
      releaseFocus();
      node.close();
      reviewTrigger.current?.focus();
    };
  }, [pending, publishPath]);
  async function review(kind: Operation) {
    if (!publishPath && document.activeElement instanceof HTMLElement) reviewTrigger.current = document.activeElement;
    const sequence = ++requestSequence.current;
    setStage('正在检查工作区…'); setError(''); setNotice('');
    try {
      const reviewed = await api<WorkspaceStatus>(kind === 'discard' ? '/workspace/discard/review' : '/workspace/review', 'POST');
      if (sequence !== requestSequence.current) return;
      if (!reviewed.confirmation) throw new Error('工作区已变化，请刷新并重新确认提交范围');
      setStatus(reviewed);
      if (kind === 'discard' && !reviewed.discardPaths?.length) {
        setPending(null); setNotice('工作区没有未提交的修改');
      } else if (kind !== 'publish') setPending(kind);
      else if (!reviewed.dirty) setPending('sync');
      else setPending('publish');
    } catch (reason) { if (sequence === requestSequence.current) { setError(errorMessage(reason)); setPending(null); } }
    finally { if (sequence === requestSequence.current) setStage(''); }
  }
  async function action(kind: 'refresh' | Operation) {
    requestSequence.current++;
    setStage(kind === 'discard' ? '正在还原工作区…' : kind === 'publish' ? (publishPath ? '正在发布…' : '正在同步仓库…') : kind === 'sync' ? '正在同步仓库…' : kind === 'refresh' ? '正在检查工作区…' : '正在保存版本…'); setError(''); setNotice('');
    let syncing = false;
    try {
      let current = status;
      if (kind === 'refresh') current = await api<WorkspaceStatus>('/workspace');
      else {
        if (!current?.confirmation) throw new Error('工作区已变化，请刷新并重新确认提交范围');
        if (kind === 'discard') {
          current = await api<WorkspaceStatus>('/workspace/discard', 'POST', { confirmation: current.confirmation });
          setNotice('已还原工作区');
        }
        if (kind === 'commit') {
          current = await api<WorkspaceStatus>('/workspace/commit', 'POST', { message, confirmation: current.confirmation });
        }
        if (kind === 'sync' || kind === 'publish') {
          const credential = nativeGitCredential.current;
          if (credential && credential.id === session.value?.identity.id && tokenInput.current?.value) {
            await credential.set(tokenInput.current.value.trim());
            tokenInput.current.value = '';
          }
          syncing = true;
          if (kind === 'publish') {
            await api('/workspace/publish', 'POST', { message, confirmation: current.confirmation });
            current = null;
            if (!publishPath) {
              try { current = await api<WorkspaceStatus>('/workspace'); }
              catch (reason) { setError(errorMessage(reason)); }
            }
          } else current = await api<WorkspaceStatus>('/workspace/sync', 'POST', { confirmation: current.confirmation });
          setAuthFailed(false);
          setPushed(true);
        }
      }
      setStatus(current);
      if (kind === 'commit') setNotice('已提交到工作区，尚未推送到远端。');
      if (kind === 'sync' || kind === 'publish') setNotice('已与 Git 远端同步；网站上线状态请以部署平台为准。');
    } catch (reason) {
      if (kind === 'publish') setNotice('内容已保存在工作区。请核对远端状态后再重试。');
      else if (syncing) setNotice(workspaceCommitNotice('unconfirmed'));
      const failure = errorMessage(reason);
      setError(failure);
      if (syncing) {
        retryOperation.current = kind === 'publish' ? 'publish' : 'sync';
        setAuthFailed(isGitAuthFailure(failure));
      }
      setStatus(null);
    }
    finally {
      if (syncing || kind === 'discard') notifyWorkspaceChanged();
      setStage(''); setPending(null);
    }
  }
  const manualMerge = status?.diverged && !status.canMerge;
  const mergeNotice = '同步时会合并远端更新。如有冲突，双方提交都会保留。';
  const credential = nativeGitCredential.current?.id === session.value?.identity.id ? nativeGitCredential.current : undefined;
  const reauthorize = authFailed && !pending && credential?.oauth && <AccountLogin key={credential.id}
    disabled={busy} reauthorize={credential.oauth} onAuthorized={() => {
      setAuthFailed(false);
      void review(publishPath ? 'publish' : retryOperation.current);
    }} />;
  const credentialField = credential && (pending === 'sync' || pending === 'publish') &&
    <details className="publish-credential" open={authFailed || !credential.hasToken()}>
      <summary>{t('仓库登录')}</summary>
      {credential.hasToken() && <button type="button" className="text-button" disabled={busy} onClick={async () => {
        setStage('处理中…');
        try { await credential.set(''); setNotice('已移除仓库授权'); setAuthFailed(true); }
        catch (reason) { setError(errorMessage(reason)); }
        finally { setStage(''); }
      }}>{t('忘记仓库授权')}</button>}
      <label className="field">{t('访问令牌')}<input ref={tokenInput} type="password" disabled={busy} autoComplete="off" placeholder={t('保存到系统凭据存储')} /></label>
    </details>;
  const blocked = status?.canSync === false ? 'App 同步需要 HTTPS 远端；本地保存和提交仍可使用'
    : manualMerge ? '双方都有新提交。请先在 Git 工具中合并，本地内容会保留。'
    : status && status.changes !== status.managedChanges?.length ? '存在托管范围以外的修改，请先在 Git 工具中处理再同步。'
    : (pending === 'sync' && status?.dirty) || (pending === 'publish' && !status?.canPublish) ? '工作区已变化，请刷新并重新确认提交范围' : '';
  if (publishPath) {
    return <dialog ref={dialog} className="publish-dialog" aria-labelledby="publish-heading"
      onCancel={event => { if (event.target === event.currentTarget) { event.preventDefault(); if (!busy) onClose?.(pushed); } }}>
      <h2 id="publish-heading">{t(pushed ? '动态已发送到仓库' : '发布动态')}</h2>
      {status && pending && !pushed && <>
        {pending === 'publish' ? <p>{t('将 {count} 个文件发布到 {branch}。', { count: status.changes, branch: status.branch })}
          {status.ahead > 0 && ' ' + t('同时发送此前保存的 {count} 个版本。', { count: status.ahead })}</p> : <p>{t('将 {count} 个已保存版本发送到 {branch}。', { count: status.ahead, branch: status.branch })}</p>}
        {status.diverged && status.canMerge && <p>{t(mergeNotice)}</p>}
        {!!status.managedChanges?.length && <details open={status.managedChanges.some(path => path !== publishPath)}>
          <summary>{t('查看文件')}</summary><ul>{status.managedChanges.map(path => <li key={path}>{path}</li>)}</ul>
        </details>}
      </>}
      {notice && (pushed || pending !== 'sync') && <p role="status">{t(pushed ? '网站部署后即可查看。' : notice)}</p>}
      {error && <ErrorNotice source="WorkspacePanel" message={error} />}
      {reauthorize}
      {blocked && !pushed && <ErrorNotice source="WorkspacePanel" message={blocked} />}
      {credentialField}
      <div className="publish-actions">
        {!pushed && <button className="secondary" disabled={busy} onClick={() => onClose?.(false)}>{t('稍后')}</button>}
        {pushed ? <button className="primary" onClick={() => onClose?.(true)}>{t('完成')}</button>
          : <button className="primary" disabled={busy} onClick={() => pending && !blocked ? void action(pending) : void review('publish')}>
            {t(busy ? stage : blocked ? '刷新状态' : !pending ? '重试' : '确认发布')}</button>}
      </div>
    </dialog>;
  }
  return <section className="settings-page workspace-panel">
    <div className="page-heading"><div><h1>{t('工作区同步')}</h1></div><button className="secondary" disabled={busy || !!pending} onClick={() => void action('refresh')}>{t('刷新状态')}</button></div>
    {error && <ErrorNotice source="WorkspacePanel" message={error} />}{notice && <p role="status" className="notice success">{t(notice)}</p>}
    {reauthorize}
    {authFailed && credential && !pending && <button className="secondary" disabled={busy} onClick={() => void review(retryOperation.current)}>{t('使用访问令牌')}</button>}
    {busy && (status
      ? <p role="status" className="muted small">{t(stage)}</p>
      : <div className="card"><LoadingState label={stage} compact={false} /></div>)}
    {status && <div className="card workspace-sync-card"><h2>{status.branch}</h2>
      <dl className="workspace-status-grid"><div><dt>{t('本地修改')}</dt><dd>{status.changes}</dd></div><div><dt>{t('待推送提交')}</dt><dd>{status.ahead}</dd></div><div><dt>{t('远端新提交（上次获取）')}</dt><dd>{status.behind}</dd></div></dl>
        {status.diverged && status.canMerge && <p>{t(mergeNotice)}</p>}
        {manualMerge && <ErrorNotice source="WorkspacePanel" message="双方都有新提交。请先在 Git 工具中合并，本地内容会保留。" />}
        <label className="field"><span>{t('提交说明')}</span><input disabled={busy || !!pending} value={message} maxLength={500} onChange={event => setMessage(event.target.value)} /></label>
        {status.canSync === false && <p className="muted small">{t('App 同步需要 HTTPS 远端；本地保存和提交仍可使用')}</p>}
        <h3>{t('本次托管文件范围')}</h3>
        <ul>{status.managedChanges?.map(path => <li key={path}><code>{path}</code></li>)}</ul>
        <p className="muted small">{t('只包含已保存的托管文件，可能包含其他文章和草稿。同步会推送当前分支已有提交，不推送保存分支，也不代表网站已部署。')}</p>
        {status.changes !== status.managedChanges?.length && <ErrorNotice source="WorkspacePanel" message="存在托管范围以外的修改，请先在 Git 工具中处理再同步。" />}
        <div className="row workspace-sync-actions"><button className={status.dirty ? "primary" : "secondary"} disabled={busy || !!pending || !status.managedChanges?.length || !message.trim()} onClick={() => void review('commit')}>{t('本地保存')}</button><button className={status.dirty ? "secondary" : "primary"} disabled={busy || !!pending || status.dirty || manualMerge || status.canSync === false} onClick={() => void review('sync')}>{t('同步 Git')}</button><button className="secondary" disabled={busy || !!pending || !status.managedChanges?.length || status.changes !== status.managedChanges.length || !message.trim() || manualMerge || status.canSync === false} onClick={() => void review('publish')}>{t('保存并同步')}</button></div>
        {status.canDiscard && <button type="button" className="secondary danger workspace-discard" disabled={busy || !!pending} onClick={() => void review('discard')}>{t('还原工作区')}</button>}
        {pending && <dialog ref={dialog} className="publish-dialog workspace-confirm" aria-labelledby="workspace-confirm-heading"
          onCancel={event => { if (event.target === event.currentTarget) { event.preventDefault(); if (!busy) setPending(null); } }}>
          <h2 id="workspace-confirm-heading" tabIndex={-1}>{t(pending === 'discard' ? '还原工作区' : pending === 'commit' ? '本地保存' : pending === 'sync' ? '同步 Git' : '保存并同步')}</h2>
          <p><strong>{status.branch}</strong>{(pending === 'sync' || pending === 'publish') && <> · {t('待推送提交')} {status.ahead}</>}</p>
          {(pending === 'commit' || pending === 'publish') && <p>{t('提交说明')} · {message}</p>}
          {pending === 'discard' && <p>{t('以下修改将被撤销，新增文件将被移除。已提交的版本会保留。')}</p>}
          {(pending === 'discard' || !!status.managedChanges?.length) && <details open>
            <summary>{t('查看文件')}</summary><ul>{(pending === 'discard' ? status.discardPaths : status.managedChanges)?.map(path => <li key={path}><code>{path}</code></li>)}</ul>
          </details>}
          {(pending === 'publish' || pending === 'sync') && status.diverged && status.canMerge && <p>{t(mergeNotice)}</p>}
          {pending !== 'discard' && <p>{t('请核对以上文件范围与待推送提交。未保存的编辑不会包含在内；失败时本地文件和提交会保留。')}</p>}
          {(pending === 'sync' || pending === 'publish') && blocked && <ErrorNotice source="WorkspacePanel" message={blocked} />}
          {credentialField}
          <div className="publish-actions"><button className={pending === 'discard' ? "primary destructive" : "primary"} disabled={busy || (!!blocked && (pending === 'sync' || pending === 'publish'))} onClick={() => void action(pending)}>{busy ? t('处理中…') : t('确认执行')}</button>
          <button className="secondary" disabled={busy} onClick={() => setPending(null)}>{t('取消')}</button></div>
        </dialog>}
    </div>}
  </section>;
}
