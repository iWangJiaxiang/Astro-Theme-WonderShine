import { ErrorNotice } from "../src/components/ErrorNotice";
import { useEffect, useId, useRef, useState } from 'react';
import { providerFetch } from './provider-fetch';
import { openUrl } from '@tauri-apps/plugin-opener';
import { beginDeviceLogin, completeDeviceLogin, loadAccount, listRepositories, ProviderAuthError, type AccountProvider, type ProviderAccount, type AccountRepository, type DeviceGrant } from './provider-auth';
import { t, type Message } from '../src/i18n';
import { useSignals } from '../src/reactivity';
import { createBusinessModal } from '../src/modal-layer';
import type { WorkspaceOAuthCredential } from './git-credential';
const providerNames = { github: 'GitHub', cnb: 'CNB' };
function loginError(reason: unknown, fallback: string): Message {
  if (reason instanceof ProviderAuthError) return { key: `${reason.message}（{diagnostics}）`, params: { diagnostics: reason.diagnostics } };
  return reason instanceof Error && /^(此版本|平台返回|授权|已取消|无法|账号|请使用此工作区原来的 Git 账号)/.test(reason.message) ? reason.message : fallback;
}
type Props = { disabled: boolean } & (
  { onSelect: (account: ProviderAccount, repository: AccountRepository) => void; reauthorize?: never; onAuthorized?: never }
  | { reauthorize: WorkspaceOAuthCredential; onAuthorized: () => void; onSelect?: never }
);
export default function AccountLogin({ onSelect, reauthorize, onAuthorized, disabled }: Props) {
  useSignals();
  const clientIds = { github: import.meta.env.VITE_STUDIO_GITHUB_CLIENT_ID || '', cnb: import.meta.env.VITE_STUDIO_CNB_CLIENT_ID || '' };
  const [provider, setProvider] = useState<AccountProvider | null>(null);
  const [grant, setGrant] = useState<DeviceGrant | null>(null), [account, setAccount] = useState<ProviderAccount | null>(null);
  const [repos, setRepos] = useState<AccountRepository[]>([]), [query, setQuery] = useState('');
  const [page, setPage] = useState(1), [more, setMore] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<Message>('');
  const [saving, setSaving] = useState(false);
  const headingId = useId();
  const controller = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const modal = useRef<ReturnType<typeof createBusinessModal> | null>(null);
  function reset() {
    modal.current?.close();
    controller.current?.abort(); controller.current = null;
    setProvider(null); setGrant(null); setAccount(null); setRepos([]); setQuery(''); setError(''); setBusy(false); setSaving(false); setPage(1); setMore(false);
  }
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!provider) return;
    const owner = createBusinessModal(() => dialog.current, () => !!controller.current && !controller.current.signal.aborted);
    modal.current = owner;
    owner.open();
    return () => {
      modal.current = null;
      owner.dispose();
    };
  }, [provider]);
  async function start(next: AccountProvider) {
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    setProvider(next); setGrant(null); setAccount(null); setRepos([]); setQuery(''); setError(''); setBusy(true); setPage(1); setMore(false);
    try {
      const device = await beginDeviceLogin(next, clientIds[next], providerFetch, request.signal);
      if (request.signal.aborted) return;
      setGrant(device);
      // A visible button retries opening if the OS declines the initial handoff.
      void openUrl(device.verificationUrl).catch(() => {});
      const credentials = await completeDeviceLogin(next, clientIds[next], device, providerFetch, request.signal);
      if (request.signal.aborted) return;
      setGrant(null);
      const user = await loadAccount(next, credentials.token, providerFetch, request.signal);
      if (request.signal.aborted) return;
      if (reauthorize) {
        setSaving(true);
        await reauthorize.authorize({ ...user, ...credentials });
        if (!request.signal.aborted) { reset(); onAuthorized(); }
        return;
      }
      setAccount({ ...user, ...credentials });
      const result = await listRepositories(user, 1, providerFetch, request.signal);
      if (request.signal.aborted) return;
      setRepos(result.repositories); setMore(result.more); setPage(1);
    } catch (reason) {
      if (!request.signal.aborted) { setGrant(null); setError(loginError(reason, '登录失败，请重试')); }
    } finally { if (!request.signal.aborted) { setBusy(false); setSaving(false); } }
  }
  async function loadMore() {
    if (!account || !controller.current) return;
    const signal = controller.current.signal; setBusy(true); setError('');
    try {
      const result = await listRepositories(account, page + 1, providerFetch, signal);
      if (signal.aborted) return;
      setRepos(current => [...new Map([...current, ...result.repositories].map(repo => [repo.id, repo])).values()]);
      setMore(result.more); setPage(current => current + 1);
    } catch (reason) { if (!signal.aborted) setError(loginError(reason, '无法读取仓库，请检查授权权限')); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  const available = (reauthorize ? [reauthorize.provider] : ['github', 'cnb'] as const).filter(id => clientIds[id]?.trim());
  if (!available.length) return null;
  return <div className={reauthorize ? 'account-reauthorize' : 'account-login'}>
    <div className="account-login-buttons">
      {available.map(id => <button key={id} type="button" className="secondary" disabled={disabled} onClick={() => void start(id)}>{t(reauthorize ? '使用 {provider} 重新登录' : '使用 {provider} 登录', { provider: providerNames[id] })}</button>)}
    </div>
    {provider && <dialog ref={dialog} className="selection-dialog oauth-dialog" aria-labelledby={headingId} onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!saving) reset(); }}>
      <section className="selection-panel"><header className="card-heading"><h2 id={headingId}>{account ? t('选择仓库') : t(reauthorize ? '使用 {provider} 重新登录' : '登录 {provider}', { provider: providerNames[provider] })}</h2><button type="button" className="text-button" disabled={saving} onClick={reset}>{t('取消')}</button></header>
        {error && <ErrorNotice source="AccountLogin" message={error} />}
        {grant && <div className="oauth-device"><p>{t('在浏览器中输入此代码')}</p><strong className="oauth-code">{grant.userCode}</strong><button type="button" className="primary" onClick={() => void openUrl(grant.verificationUrl).catch(() => setError('无法打开授权页面，请重试'))}>{t('打开授权页面')}</button><span role="status">{t('等待授权…')}</span></div>}
        {account && onSelect && <><label className="selection-search"><span>{t('搜索仓库')}</span><input autoComplete="off" autoCapitalize="none" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('筛选已加载的仓库')} /></label>
          <div className="oauth-repositories" aria-busy={busy}>{repos.filter(repo => repo.name.toLowerCase().includes(query.toLowerCase())).map(repo => <button key={repo.id} type="button" className="oauth-repository" onClick={() => { onSelect(account, repo); reset(); }}><span>{repo.name}</span><small>{repo.private ? t('私有') : t('公开')}</small></button>)}
            {!busy && !error && !repos.length && <p className="muted">{t('没有可写入的仓库')}</p>}
          </div><footer className="selection-footer"><span>{account.username}</span>{more && <button type="button" className="secondary" disabled={busy} onClick={() => void loadMore()}>{t('加载更多')}</button>}</footer></>}
        {busy && !grant && <p role="status" className="oauth-status">{t('正在连接…')}</p>}
        {!busy && error && clientIds[provider] && <button type="button" className="secondary" onClick={() => void start(provider)}>{t('重新登录')}</button>}
      </section>
    </dialog>}
  </div>;
}
