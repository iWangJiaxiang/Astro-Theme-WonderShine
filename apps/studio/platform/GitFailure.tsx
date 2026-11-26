import { useRef, useState, type ReactNode } from 'react';
import { errorMessage, session } from '../src/api';
import { ErrorNotice } from '../src/components/ErrorNotice';
import { t, type Message } from '../src/i18n';
import AccountLogin, { providerClientId } from './AccountLogin';
import { isGitAuthFailure, nativeGitCredential } from './git-credential';

export function GitFailure({ message, source, disabled, onAuthorized, children, onToken }: {
  message: Message; source: string; disabled: boolean; onAuthorized: () => void; children?: ReactNode; onToken?: () => void;
}) {
  const credential = nativeGitCredential.current;
  const input = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false), [failure, setFailure] = useState<Message>('');
  if (!credential || credential.id !== session.value?.identity.id || !isGitAuthFailure(message)) {
    return <ErrorNotice source={source} message={message}>{children}</ErrorNotice>;
  }
  const expired = (typeof message === 'string' ? message : message.key) === '授权已过期，请重新登录';
  const oauth = credential.oauth;
  return <>
    {expired ? <p role="status" className="muted small">{t('仓库授权已过期')}</p> : <ErrorNotice source={source} message={message} />}
    {oauth && providerClientId(oauth.provider) && <AccountLogin disabled={disabled} reauthorize={oauth} onAuthorized={onAuthorized} />}
    {onToken ? <button type="button" className="secondary" disabled={disabled} onClick={onToken}>{t('使用访问令牌')}</button> :
      <details className="publish-credential"><summary>{t('使用访问令牌')}</summary>
        <label className="field">{t('访问令牌')}<input ref={input} type="password" autoComplete="off" disabled={disabled || saving} /></label>
        <button type="button" className="secondary" disabled={disabled || saving} onClick={async () => {
          const token = input.current?.value.trim();
          if (!token || nativeGitCredential.current !== credential) return;
          setSaving(true); setFailure('');
          try {
            await credential.set(token);
            if (input.current && nativeGitCredential.current === credential) { input.current.value = ''; onAuthorized(); }
          } catch (reason) { setFailure(errorMessage(reason)); }
          finally { setSaving(false); }
        }}>{t('保存令牌')}</button>
        {failure && <ErrorNotice source={source} message={failure} />}
      </details>}
  </>;
}
