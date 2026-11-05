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
type LoginStage = 'device' | 'token' | 'account' | 'repos';
const stageErrors: Record<LoginStage, string> = {
  device: '无法启动设备授权，请重试', token: '无法获取授权结果，请重新登录',
  account: '无法读取账号资料，请检查授权权限', repos: '无法读取仓库，请检查授权权限',
};
export class ProviderAuthError extends Error {
  readonly diagnostics: string;
  constructor(stage: LoginStage, response?: Response, message = stageErrors[stage]) {
    super(message);
    this.name = 'ProviderAuthError';
    const details = [`stage=${stage}`, response ? `HTTP=${response.status}` : 'HTTP=unavailable'];
    // Only known diagnostic headers with bounded identifier formats may reach the UI.
    for (const [header, pattern] of [
      ['x-trace-id', /^[a-f0-9]{16,64}$/i],
      ['traceparent', /^[a-f0-9]{2}-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2}$/i],
      ['x-github-request-id', /^[a-f0-9]{4,8}(?::[a-f0-9]{4,12}){3,5}$/i],
    ] as const) {
      const value = response?.headers.get(header);
      if (value && pattern.test(value)) details.push(`${header}=${value}`);
    }
    this.diagnostics = details.join('; ');
  }
}
function object(value: unknown, invalid = new Error('平台返回了无效响应')): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid;
  return value as Record<string, unknown>;
}
export function verificationUrl(provider: AccountProvider, value: string): string {
  const url = new URL(value);
  if (url.origin !== providers[provider].origin || url.username || url.password
    || (provider === 'github' && !/^\/login\/device(?:\/|$)/.test(url.pathname))) throw new Error('授权地址无效');
  return url.href;
}
async function json(fetcher: ProviderFetch, url: string, init: RequestInit, signal: AbortSignal, stage: LoginStage, timeout = 30000) {
  signal.throwIfAborted();
  const oauth = stage === 'device' || stage === 'token';
  const headers = new Headers(init.headers);
  headers.set('User-Agent', 'WonderShine-Studio');
  let response: Response;
  try {
    response = await fetcher(url, { ...init, headers, redirect: 'error', credentials: 'omit', signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, timeout))]) });
  } catch {
    signal.throwIfAborted();
    throw new ProviderAuthError(stage);
  }
  const failure = (message?: string) => new ProviderAuthError(stage, response, message);
  const discard = async () => {
    try { await response.body?.cancel(); }
    catch { /* Best-effort cleanup must not expose transport details or replace diagnostics. */ }
    signal.throwIfAborted();
  };
  if (response.url && new URL(response.url).origin !== new URL(url).origin) { await discard(); throw failure('平台返回了无效响应'); }
  // Parse only expected responses; never surface token-bearing response bodies in UI/logs.
  if (!response.ok && !(oauth && (response.status === 400 || response.status === 401))) { await discard(); throw failure(); }
  let data: unknown;
  try { data = await response.json(); }
  catch { signal.throwIfAborted(); throw failure('平台返回了无效响应'); }
  if (oauth && !response.ok) {
    const error = object(data, failure('平台返回了无效响应')).error;
    if (error === 'invalid_client' || error === 'unauthorized_client') throw failure('账号登录应用配置无效，请联系应用维护者');
    if (response.status === 401) throw failure();
  }
  return { data, ok: response.ok, failure };
}
export async function beginDeviceLogin(provider: AccountProvider, clientId: string, fetcher: ProviderFetch, signal: AbortSignal): Promise<DeviceGrant> {
  if (!clientId.trim()) throw new Error('此版本尚未配置账号登录');
  const config = providers[provider];
  const body = new URLSearchParams({ client_id: clientId });
  if (provider === 'github') body.set('scope', 'repo');
  const result = await json(fetcher, config.origin + config.device, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() }, signal, 'device');
  if (!result.ok) throw result.failure();
  const data = object(result.data, result.failure('平台返回了无效响应'));
  const expires = Number(data.expires_in), interval = Number(data.interval ?? 5);
  if (!text(data.device_code) || !text(data.user_code) || !Number.isFinite(expires) || expires <= 0
    || !Number.isFinite(interval) || interval <= 0) throw result.failure('平台返回了无效响应');
  let url: string;
  try { url = verificationUrl(provider, text(data.verification_uri_complete || data.verification_uri)); }
  catch { throw result.failure('授权地址无效'); }
  return { deviceCode: text(data.device_code), userCode: text(data.user_code),
    verificationUrl: url,
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
      body: new URLSearchParams({ client_id: clientId, device_code: grant.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }).toString() }, signal, 'token', Math.min(30000, grant.expiresAt - Date.now()));
    const data = object(result.data, result.failure('平台返回了无效响应'));
    if (result.ok && text(data.access_token)) {
      if (text(data.token_type).toLowerCase() !== 'bearer') throw result.failure('平台返回了无效响应');
      return text(data.access_token);
    }
    switch (data.error) {
      case 'authorization_pending': break;
      case 'slow_down': interval += 5000; break;
      case 'access_denied': throw result.failure('已取消授权');
      case 'expired_token': throw result.failure('授权已过期，请重新登录');
      default: throw result.failure('授权失败，请重新登录');
    }
  }
  signal.throwIfAborted();
  throw new ProviderAuthError('token', undefined, '授权已过期，请重新登录');
}
async function api(provider: AccountProvider, token: string, pathname: string, fetcher: ProviderFetch, signal: AbortSignal, stage: 'account' | 'repos') {
  return json(fetcher, providers[provider].api + pathname, { headers: {
    Authorization: `Bearer ${token}`, Accept: provider === 'github' ? 'application/vnd.github+json' : 'application/vnd.cnb.api+json',
  } }, signal, stage);
}
export async function loadAccount(provider: AccountProvider, token: string, fetcher: ProviderFetch, signal: AbortSignal): Promise<ProviderAccount> {
  const result = await api(provider, token, '/user', fetcher, signal, 'account');
  const data = object(result.data, result.failure('平台返回了无效响应'));
  const username = text(provider === 'github' ? data.login : data.username);
  if (!username || /[\r\n\x00]/.test(username)) throw result.failure('平台返回了无效响应');
  return { provider, token, username, name: text(provider === 'github' ? data.name : data.nickname) || username, email: text(data.email) };
}
export async function listRepositories(account: ProviderAccount, page: number, fetcher: ProviderFetch, signal: AbortSignal): Promise<{ repositories: AccountRepository[]; more: boolean }> {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('无效页码');
  const github = account.provider === 'github';
  const query = github ? `?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member` : `?page_size=100&page=${page}&role=Developer&status=active`;
  const result = await api(account.provider, account.token, '/user/repos' + query, fetcher, signal, 'repos');
  const data = result.data;
  const invalid = result.failure('平台返回了无效响应');
  if (!Array.isArray(data)) throw invalid;
  const repositories = data.flatMap(item => {
    const row = object(item, invalid);
    if (github && (row.archived || row.disabled || !object(row.permissions || {}, invalid).push)) return [];
    if (!github && row.freeze) return [];
    const name = text(github ? row.full_name : row.path);
    if (!name || name.split('/').length < 2 || name.split('/').some(part => !part || part === '.' || part === '..') || /[\s?#\\\x00-\x1f]/.test(name)) throw invalid;
    // Construct from the trusted platform origin, never a token-bearing API redirect/clone URL.
    return [{ id: String(row.id), name, url: `${providers[account.provider].origin}/${name}.git`,
      branch: github ? text(row.default_branch) : '', private: github ? !!row.private : text(row.visibility_level).toLowerCase() !== 'public' }];
  });
  return { repositories, more: data.length === 100 };
}
