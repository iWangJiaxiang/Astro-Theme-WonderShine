import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { t, type Message } from '../i18n';
import { useSignals } from '../reactivity';
import { notifyWorkspaceChanged } from '../workspace-events';
import type { WorkspaceStatus } from '../../shared/workspace';
import Icon from './Icon';
import { ErrorNotice } from './ErrorNotice';

type Counts = Pick<WorkspaceStatus, 'ahead' | 'behind'>;
const check = () => api<Counts>('/workspace/check', 'POST');

export function QuickSync({ editing, onManage }: { editing: () => boolean; onManage: () => void }) {
  useSignals();
  const owner = useRef(0), running = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [busy, setBusy] = useState(true), [updates, setUpdates] = useState(false);
  const [steps, setSteps] = useState<Message[]>([]), [error, setError] = useState<Message>('');
  const [hint, setHint] = useState<Message>('同步 Git');
  useEffect(() => {
    const active = ++owner.current;
    void check().then(({ ahead, behind }) => {
      if (active === owner.current) setUpdates(ahead + behind > 0);
    }).catch(reason => {
      if (active === owner.current) setHint(errorMessage(reason));
    }).finally(() => { if (active === owner.current) setBusy(false); });
    return () => { owner.current++; clearTimeout(timer.current); };
  }, []);
  async function sync() {
    if (running.current || busy) return;
    const active = owner.current;
    running.current = true;
    clearTimeout(timer.current);
    setBusy(true); setSteps([]); setError(''); setHint('同步 Git');
    try {
      const { ahead, behind } = await check();
      if (active !== owner.current) return;
      setUpdates(ahead + behind > 0);
      if (!ahead && !behind) { setHint('分支已同步'); return; }
      setSteps([{ key: '待拉取 {behind} 个提交，待推送 {ahead} 个提交', params: { ahead, behind } }]);
      const review = await api<WorkspaceStatus>('/workspace/review', 'POST');
      if (active !== owner.current) return;
      if (review.dirty || editing()) throw new Error('请先保存编辑并提交工作区更改，再同步 Git。');
      if (!review.confirmation) throw new Error('工作区已变化，请刷新并重新确认提交范围');
      setSteps(current => [...current, { key: '正在同步分支 {branch}…', params: { branch: review.branch } }]);
      await api('/workspace/sync', 'POST', { confirmation: review.confirmation });
      if (active !== owner.current) return;
      setSteps(current => [...current, '分支已同步']); setUpdates(false); setHint('分支已同步');
      notifyWorkspaceChanged();
      timer.current = setTimeout(() => setSteps([]), 1800);
    } catch (reason) {
      if (active === owner.current) setError(errorMessage(reason));
    } finally {
      if (active === owner.current) { running.current = false; setBusy(false); }
    }
  }
  return <div className="quick-sync">
    <button className="icon-button" type="button" aria-label={t('同步 Git')} title={t(updates ? '有提交待同步' : hint)}
      disabled={busy} data-updates={updates || undefined} aria-busy={busy} onClick={() => void sync()}><Icon name="switchWorkspace" /></button>
    {(steps.length > 0 || error) && <section className="quick-sync-progress" aria-label={t('同步 Git')}><ol role="status">{steps.map((step, i) => <li key={i}>{t(step)}</li>)}</ol>
      {error && <><ErrorNotice source="QuickSync" message={error} /><button onClick={() => { setSteps([]); setError(''); onManage(); }}>{t('工作区同步')}</button> <button onClick={() => { setSteps([]); setError(''); }}>{t('关闭')}</button></>}
    </section>}
  </div>;
}
