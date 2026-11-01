import { useEffect, useRef, useState } from 'react';
import { fetch as nativeFetch } from '@tauri-apps/plugin-http';
import { openUrl } from '@tauri-apps/plugin-opener';
import { beginDeviceLogin, completeDeviceLogin, loadAccount, listRepositories, type AccountProvider, type ProviderAccount, type AccountRepository, type DeviceGrant } from './provider-auth';
import { t } from '../src/i18n';
import { useSignals } from '../src/reactivity';
const clientIds = { github: import.meta.env.VITE_STUDIO_GITHUB_CLIENT_ID || '', cnb: import.meta.env.VITE_STUDIO_CNB_CLIENT_ID || '' };
export default function AccountLogin({ onSelect, disabled }: { onSelect: (account: ProviderAccount, repository: AccountRepository) => void; disabled: boolean }) {
  useSignals();
  const [provider, setProvider] = useState<AccountProvider | null>(null);
  const [grant, setGrant] = useState<DeviceGrant | null>(null), [account, setAccount] = useState<ProviderAccount | null>(null);
  const [repos, setRepos] = useState<AccountRepository[]>([]), [query, setQuery] = useState('');
  const [page, setPage] = useState(1), [more, setMore] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  function reset() {
    controller.current?.abort(); controller.current = null;
    setProvider(null); setGrant(null); setAccount(null); setRepos([]); setQuery(''); setError(''); setBusy(false); setPage(1); setMore(false);
  }
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { if (provider) dialog.current?.showModal(); }, [provider]);
  async function start(next: AccountProvider) {
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    setProvider(next); setGrant(null); setAccount(null); setRepos([]); setQuery(''); setError(''); setBusy(true); setPage(1); setMore(false);
    try {
      const device = await beginDeviceLogin(next, clientIds[next], nativeFetch, request.signal);
      if (request.signal.aborted) return;
      setGrant(device);
      // A visible button retries opening if the OS declines the initial handoff.
      void openUrl(device.verificationUrl).catch(() => {});
      const token = await completeDeviceLogin(next, clientIds[next], device, nativeFetch, request.signal);
      const user = await loadAccount(next, token, nativeFetch, request.signal);
      if (request.signal.aborted) return;
      setGrant(null); setAccount(user);
      const result = await listRepositories(user, 1, nativeFetch, request.signal);
      if (request.signal.aborted) return;
      setRepos(result.repositories); setMore(result.more); setPage(1);
    } catch (reason) {
      if (!request.signal.aborted) setError(reason instanceof Error && /^(此版本|平台返回|授权|已取消|无法|账号)/.test(reason.message) ? reason.message : '登录失败，请重试');
    } finally { if (!request.signal.aborted) setBusy(false); }
  }
  async function loadMore() {
    if (!account || !controller.current) return;
    const signal = controller.current.signal; setBusy(true); setError('');
    try {
      const result = await listRepositories(account, page + 1, nativeFetch, signal);
      if (signal.aborted) return;
      setRepos(current => [...new Map([...current, ...result.repositories].map(repo => [repo.id, repo])).values()]);
      setMore(result.more); setPage(current => current + 1);
    } catch { if (!signal.aborted) setError('无法读取仓库，请检查授权权限'); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  return <div className="account-login">
    <div className="account-login-buttons">
      {(['github', 'cnb'] as const).map(id => <button key={id} type="button" className="secondary" disabled={disabled} onClick={() => void start(id)}>{t('使用 {provider} 登录', { provider: id === 'github' ? 'GitHub' : 'CNB' })}</button>)}
    </div>
    {provider && <dialog ref={dialog} className="selection-dialog oauth-dialog" onCancel={reset} onClose={reset}>
      <section className="selection-panel"><header className="card-heading"><h2>{account ? t('选择仓库') : t('登录 {provider}', { provider: provider === 'github' ? 'GitHub' : 'CNB' })}</h2><button type="button" className="text-button" onClick={() => dialog.current?.close()}>{t('取消')}</button></header>
        {error && <p className="notice error" role="alert">{t(error)}</p>}
        {grant && <div className="oauth-device"><p>{t('在浏览器中输入此代码')}</p><strong className="oauth-code">{grant.userCode}</strong><button type="button" className="primary" onClick={() => void openUrl(grant.verificationUrl).catch(() => setError('无法打开授权页面，请重试'))}>{t('打开授权页面')}</button><span role="status">{t('等待授权…')}</span></div>}
        {account && <><label className="selection-search"><span>{t('搜索仓库')}</span><input autoComplete="off" autoCapitalize="none" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('筛选已加载的仓库')} /></label>
          <div className="oauth-repositories" aria-busy={busy}>{repos.filter(repo => repo.name.toLowerCase().includes(query.toLowerCase())).map(repo => <button key={repo.id} type="button" className="oauth-repository" onClick={() => { onSelect(account, repo); dialog.current?.close(); }}><span>{repo.name}</span><small>{repo.private ? t('私有') : t('公开')}</small></button>)}
            {!busy && !repos.length && <p className="muted">{t('没有可写入的仓库')}</p>}
          </div><footer className="selection-footer"><span>{account.username}</span>{more && <button type="button" className="secondary" disabled={busy} onClick={() => void loadMore()}>{t('加载更多')}</button>}</footer></>}
        {busy && !grant && <p role="status" className="oauth-status">{t('正在连接…')}</p>}
        {!busy && error && clientIds[provider] && <button type="button" className="secondary" onClick={() => void start(provider)}>{t('重新登录')}</button>}
      </section>
    </dialog>}
  </div>;
}
