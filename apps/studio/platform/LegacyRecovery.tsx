import { useState } from 'react';
import { session } from '../src/api';
import { useSignals } from '../src/reactivity';
import { t } from '../src/i18n';
import { importLegacyRecovery, legacyRecovery } from './legacy-recovery';

export function LegacyRecovery() {
  useSignals();
  const [message, setMessage] = useState('');
  const context = legacyRecovery.value;
  const identity = session.value?.identity;
  if (!context || identity?.id !== context.current.id || identity.method !== context.current.method) return null;
  return <details className="legacy-recovery">
    <summary>{t('恢复旧版远程草稿')}</summary>
    <p>{t('旧版草稿没有工作区编号。请确认它们属于当前工作区；仅复制同一服务、登录方式和账号的数据，不删除原件，也不覆盖已有数据。')}</p>
    <p style={{ overflowWrap: 'anywhere' }}>{context.legacy.id}</p>
    <button onClick={() => {
      if (!confirm(t('确认将此账号的旧版草稿和设置复制到当前工作区？'))) return;
      try {
        importLegacyRecovery(localStorage, context, session.value?.identity);
        setMessage('恢复复制完成。已有数据保持不变；请重新打开工作区查看草稿和设置。');
      } catch { setMessage('恢复失败。原件保持不变，请检查存储权限并重试。'); }
    }}>{t('复制旧草稿和设置')}</button>
    {message && <p role="status">{t(message)}</p>}
  </details>;
}
