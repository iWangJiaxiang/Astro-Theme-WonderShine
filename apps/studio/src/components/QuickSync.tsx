import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, errorMessage, session } from '../api';
import { t, type Message } from '../i18n';
import { useSignals } from '../reactivity';
import { notifyWorkspaceChanged } from '../workspace-events';
import type { WorkspaceStatus } from '../../shared/workspace';
import type { GitSyncAction } from '../navigation-refresh';
import type { Ref } from '../reactivity';
import Modal from './Modal';
import { ErrorNotice } from './ErrorNotice';
import AccountLogin from '../../platform/AccountLogin';
import { isGitAuthFailure, nativeGitCredential } from '../../platform/git-credential';

type Counts = Pick<WorkspaceStatus, 'ahead' | 'behind'>;
const check = () => api<Counts>('/workspace/check', 'POST');

export default function QuickSync({ action, editing, onManage }: { action: Ref<GitSyncAction | null>; editing: () => boolean; onManage: () => void }) {
  useSignals();
  const owner = useRef(0), running = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [busy, setBusy] = useState(true), [updates, setUpdates] = useState(false);
  const [visible, setVisible] = useState(false);
  const [reconnected, setReconnected] = useState(false);
  const [steps, setSteps] = useState<Message[]>([]), [error, setError] = useState<Message>('');
  const [hint, setHint] = useState<Message>('同步 Git 并刷新当前内容');
  const retryRefresh = useRef<Parameters<GitSyncAction['run']>[0] | undefined>(undefined);
  useEffect(() => {
    const active = ++owner.current;
    void check().then(({ ahead, behind }) => {
      if (active === owner.current) setUpdates(ahead + behind > 0);
    }).catch(reason => {
      if (active === owner.current) setHint(errorMessage(reason));
    }).finally(() => { if (active === owner.current) setBusy(false); });
    return () => { owner.current++; clearTimeout(timer.current); };
  }, []);
  useLayoutEffect(() => {
    action.value = { busy, updates, hint, run: sync };
    return () => { action.value = null; };
  });
  async function sync(afterSync = retryRefresh.current) {
    if (running.current || busy) return;
    const active = owner.current;
    retryRefresh.current = afterSync;
    running.current = true;
    clearTimeout(timer.current);
    setBusy(true); setSteps([]); setError(''); setReconnected(false); setHint('同步 Git 并刷新当前内容');
    let attemptedSync = false;
    try {
      const { ahead, behind } = await check();
      if (active !== owner.current) return;
      setUpdates(ahead + behind > 0);
      if (!ahead && !behind) { setHint('分支已同步'); return; }
      setVisible(true);
      setSteps([{ key: '待拉取 {behind} 个提交，待推送 {ahead} 个提交', params: { ahead, behind } }]);
      const review = await api<WorkspaceStatus>('/workspace/review', 'POST');
      if (active !== owner.current) return;
      if (review.dirty || editing()) throw new Error('请先保存编辑并提交工作区更改，再同步 Git。');
      if (!review.confirmation) throw new Error('工作区已变化，请刷新并重新确认提交范围');
      setSteps(current => [...current, { key: '正在同步分支 {branch}…', params: { branch: review.branch } }]);
      attemptedSync = true;
      await api('/workspace/sync', 'POST', { confirmation: review.confirmation });
      if (active !== owner.current) return;
      setSteps(current => [...current, ...(behind ? ['已合入远端更新'] : []), ...(ahead ? ['已推送本地提交'] : []), '分支已同步']); setUpdates(false); setHint('分支已同步');
      timer.current = setTimeout(() => setSteps([]), 1800);
    } catch (reason) {
      if (active === owner.current) { setError(errorMessage(reason)); setVisible(true); }
    } finally {
      if (active === owner.current) {
        if (attemptedSync) await notifyWorkspaceChanged();
        if (active === owner.current) {
          running.current = false; setBusy(false);
          afterSync?.(attemptedSync);
        }
      }
    }
  }
  const credential = nativeGitCredential.current;
  const oauth = credential?.id === session.value?.identity.id ? credential?.oauth : undefined;
  return <>
    {visible && (steps.length > 0 || error) && <Modal className="quick-sync-progress" label={t('同步 Git')} onCancel={() => setVisible(false)}><h2>{t('同步 Git')}</h2><ol role="status">{steps.map((step, i) => <li key={i}>{t(step)}</li>)}</ol>
      {error && <ErrorNotice source="QuickSync" message={error} />}
      {oauth && isGitAuthFailure(error) && <AccountLogin disabled={busy} reauthorize={oauth} onAuthorized={() => {
        setError(''); setSteps(['仓库授权已更新']); setReconnected(true); setHint('同步 Git');
      }} />}
      {error && <div className="error-actions"><button className="secondary" onClick={() => { setSteps([]); setError(''); onManage(); }}>{t('工作区同步')}</button> <button className="secondary" onClick={() => { setSteps([]); setError(''); }}>{t('关闭')}</button></div>}
      {reconnected && <button className="primary" type="button" disabled={busy} onClick={() => void sync()}>{t('重试同步')}</button>}
    </Modal>}
  </>;
}
