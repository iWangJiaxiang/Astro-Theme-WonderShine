/** Public-client device authorization. No Studio service or client secret participates. */
export type AccountProvider = 'github' | 'cnb';
export type ProviderFetch = (url: string, init?: RequestInit) => Promise<Response>;
export interface DeviceGrant { deviceCode: string; userCode: string; verificationUrl: string; interval: number; expiresAt: number }
export interface ProviderAccount { provider: AccountProvider; token: string; username: string; name: string; email: string }
export interface AccountRepository { id: string; name: string; url: string; branch: string; private: boolean }
const providers = {
  github: { origin: 'https://github.com', api: 'https://api.github.com', device: '/login/device/code', token: '/login/oauth/access_token' },
  cnb: { origin: 'https://cnb.cool', api: 'https://api.cnb.cool', device: '/oauth2/device/auth', token: '/oauth2/token' },
} as const;
const text = (value: unknown): string => typeof value === 'string' ? value : '';
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('平台返回了无效响应');
  return value as Record<string, unknown>;
}
export function verificationUrl(provider: AccountProvider, value: string): string {
  const url = new URL(value);
  if (url.origin !== providers[provider].origin || url.username || url.password
    || (provider === 'github' && !/^\/login\/device(?:\/|$)/.test(url.pathname))) throw new Error('授权地址无效');
  return url.href;
}
async function json(fetcher: ProviderFetch, url: string, init: RequestInit, signal: AbortSignal, timeout = 30000) {
  signal.throwIfAborted();
  const response = await fetcher(url, { ...init, redirect: 'error', credentials: 'omit', signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, timeout))]) });
  // Parse only expected responses; never surface token-bearing response bodies in UI/logs.
  if (!response.ok && response.status !== 400) { await response.body?.cancel(); throw new Error('无法连接账号平台，请重试'); }
  const data: unknown = await response.json();
  return { data, ok: response.ok };
}
export async function beginDeviceLogin(provider: AccountProvider, clientId: string, fetcher: ProviderFetch, signal: AbortSignal): Promise<DeviceGrant> {
  if (!clientId.trim()) throw new Error('此版本尚未配置账号登录');
  const config = providers[provider];
  const body = new URLSearchParams({ client_id: clientId });
  if (provider === 'github') body.set('scope', 'repo');
  const result = await json(fetcher, config.origin + config.device, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() }, signal);
  if (!result.ok) throw new Error('无法启动授权，请重试');
  const data = object(result.data);
  const expires = Number(data.expires_in), interval = Number(data.interval ?? 5);
  if (!text(data.device_code) || !text(data.user_code) || !Number.isFinite(expires) || expires <= 0
    || !Number.isFinite(interval) || interval <= 0) throw new Error('平台返回了无效响应');
  return { deviceCode: text(data.device_code), userCode: text(data.user_code),
    verificationUrl: verificationUrl(provider, text(data.verification_uri_complete || data.verification_uri)),
    interval: Math.max(1000, interval * 1000), expiresAt: Date.now() + Math.min(expires, 3600) * 1000 };
}
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const cancel = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}
export async function completeDeviceLogin(provider: AccountProvider, clientId: string, grant: DeviceGrant, fetcher: ProviderFetch, signal: AbortSignal,
  wait: typeof delay = delay): Promise<string> {
  let interval = grant.interval;
  const config = providers[provider];
  while (Date.now() < grant.expiresAt) {
    await wait(Math.min(interval, grant.expiresAt - Date.now()), signal);
    signal.throwIfAborted();
    if (Date.now() >= grant.expiresAt) break;
    const result = await json(fetcher, config.origin + config.token, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, device_code: grant.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }).toString() }, signal, Math.min(30000, grant.expiresAt - Date.now()));
    const data = object(result.data);
    if (result.ok && text(data.access_token)) {
      if (text(data.token_type).toLowerCase() !== 'bearer') throw new Error('平台返回了无效响应');
      return text(data.access_token);
    }
    switch (data.error) {
      case 'authorization_pending': break;
      case 'slow_down': interval += 5000; break;
      case 'access_denied': throw new Error('已取消授权');
      case 'expired_token': throw new Error('授权已过期，请重新登录');
      default: throw new Error('授权失败，请重新登录');
    }
  }
  throw new Error('授权已过期，请重新登录');
}
async function api(provider: AccountProvider, token: string, pathname: string, fetcher: ProviderFetch, signal: AbortSignal): Promise<unknown> {
  const result = await json(fetcher, providers[provider].api + pathname, { headers: {
    Authorization: `Bearer ${token}`, Accept: provider === 'github' ? 'application/vnd.github+json' : 'application/vnd.cnb.api+json',
  } }, signal);
  if (!result.ok) throw new Error('无法读取仓库，请检查授权权限');
  return result.data;
}
export async function loadAccount(provider: AccountProvider, token: string, fetcher: ProviderFetch, signal: AbortSignal): Promise<ProviderAccount> {
  const data = object(await api(provider, token, '/user', fetcher, signal));
  const username = text(provider === 'github' ? data.login : data.username);
  if (!username || /[\r\n\x00]/.test(username)) throw new Error('平台返回了无效响应');
  return { provider, token, username, name: text(provider === 'github' ? data.name : data.nickname) || username, email: text(data.email) };
}
export async function listRepositories(account: ProviderAccount, page: number, fetcher: ProviderFetch, signal: AbortSignal): Promise<{ repositories: AccountRepository[]; more: boolean }> {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('无效页码');
  const github = account.provider === 'github';
  const query = github ? `?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member` : `?page_size=100&page=${page}&role=Developer&status=active`;
  const data = await api(account.provider, account.token, '/user/repos' + query, fetcher, signal);
  if (!Array.isArray(data)) throw new Error('平台返回了无效响应');
  const repositories = data.flatMap(item => {
    const row = object(item);
    if (github && (row.archived || row.disabled || !object(row.permissions || {}).push)) return [];
    if (!github && row.freeze) return [];
    const name = text(github ? row.full_name : row.path);
    if (!name || name.split('/').length < 2 || name.split('/').some(part => !part || part === '.' || part === '..') || /[\s?#\\\x00-\x1f]/.test(name)) throw new Error('平台返回了无效响应');
    // Construct from the trusted platform origin, never a token-bearing API redirect/clone URL.
    return [{ id: String(row.id), name, url: `${providers[account.provider].origin}/${name}.git`,
      branch: github ? text(row.default_branch) : '', private: github ? !!row.private : row.visibility_level !== 'public' }];
  });
  return { repositories, more: data.length === 100 };
}
