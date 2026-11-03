/** Native-only HTTPS transport. Cookies stay in memory and never enter localStorage. */
export function createRemoteTransport(address: string, requestFetch: typeof fetch, disconnected: () => void = () => {}, workspaceId?: string) {
  const origin = new URL(address);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('请输入不含路径的 HTTPS 创作中心地址');
  let cookie = '';
  const lifetime = new AbortController();
  const dispose = () => { cookie = ''; lifetime.abort(); };
  const transport = async (path: string, init: RequestInit): Promise<Response> => {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('接口地址无效');
    const target = new URL('/api' + path, origin);
    if (target.origin !== origin.origin || !/^\/api\/[a-z0-9_/-]+$/i.test(target.pathname) || target.hash || path.split('?')[0].split('/').some(part => part === '.' || part === '..') || path.split('?')[0].includes('\\')) throw new Error('接口地址无效');
    lifetime.signal.throwIfAborted();
    const timeout = path === '/auth/config' ? 15_000 : init.method === 'POST' ? 300_000 : 60_000;
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeout), ...(init.signal ? [init.signal] : [])]);
    signal.throwIfAborted();
    const headers = new Headers(init.headers);
    headers.set('Origin', origin.origin);
    if (cookie) headers.set('Cookie', cookie);
    let response: Response;
    try { response = await requestFetch(target, { ...init, headers, signal, credentials: 'omit', redirect: 'error' }); }
    catch (error) { signal.throwIfAborted(); throw error; }
    if (signal.aborted) { await response.body?.cancel().catch(() => {}); signal.throwIfAborted(); }
    if (response.status >= 300 && response.status < 400 || response.url && new URL(response.url).origin !== origin.origin) {
      await response.body?.cancel().catch(() => {});
      throw new Error('创作中心请求不允许重定向');
    }
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const match = /(?:^|,\s*)(__Host-studio-session)=([^;\s,]*)/.exec(setCookie);
      if (match) cookie = `${match[1]}=${match[2]}`;
    }
    if (path === '/auth/logout' && response.ok) {
      const body = await response.arrayBuffer();
      signal.throwIfAborted();
      dispose(); disconnected();
      return new Response(body, { status: response.status, headers: response.headers });
    }
    if (response.ok && ['/auth/config', '/auth/session', '/auth/login'].includes(path)) {
      const data = await response.json().catch(error => { signal.throwIfAborted(); throw error; });
      signal.throwIfAborted();
      // Browser OIDC redirects require a separate app callback flow, not WebView navigation.
      if (path === '/auth/config') data.oidc = null;
      if (data.identity?.id) data.identity.id = `remote:${workspaceId ? workspaceId + ':' : ''}${origin.origin}:${data.identity.id}`;
      return new Response(JSON.stringify(data), { status: response.status, headers: { 'Content-Type': 'application/json' } });
    }
    return response;
  };
  return Object.assign(transport, { dispose });
}
