import { invoke } from '@tauri-apps/api/core';
import { fetch as nativeFetch } from '@tauri-apps/plugin-http';
import type { ProviderFetch } from './provider-auth';

type CnbResponse = { status: number; headers: [string, string][]; body: string };
type CnbInvoke = (command: string, args: Record<string, unknown>) => Promise<CnbResponse>;

// Match the original string, not a normalized URL (no aliases, credentials, ports or extra query).
function cnbResource(url: string): { resource: 'account' | 'repos'; page?: number } | null {
  if (url === 'https://api.cnb.cool/user') return { resource: 'account' };
  const match = /^https:\/\/api\.cnb\.cool\/user\/repos\?page_size=100&page=([1-9][0-9]{0,6})&role=Developer&status=active$/.exec(url);
  if (!match || Number(match[1]) > 1_000_000) return null;
  return { resource: 'repos', page: Number(match[1]) };
}

/** Only CNB discovery bypasses the browser-Origin plugin; all other HTTP stays unchanged. */
export function createProviderFetch(fallback: ProviderFetch, call: CnbInvoke): ProviderFetch {
  return async (url, init) => {
    const resource = cnbResource(url);
    if (!resource) return fallback(url, init);
    const signal = init?.signal;
    signal?.throwIfAborted();
    const headers = new Headers(init?.headers);
    const authorization = headers.get('authorization') || '';
    if ((init?.method ?? 'GET') !== 'GET' || init?.body != null
      || (init?.credentials != null && init.credentials !== 'omit')
      || (init?.redirect != null && init.redirect !== 'error')
      || !/^Bearer [A-Za-z0-9\-._~+/=]{1,8192}$/.test(authorization)
      || [...headers.keys()].some(name => !['authorization', 'accept', 'user-agent'].includes(name))) {
      throw new Error('Invalid CNB discovery request');
    }
    // Invoke has no AbortSignal contract. Reject promptly, consume late completions and never
    // update the cancelled UI. Rust bounds outstanding work (30 seconds, four requests).
    return new Promise<Response>((resolve, reject) => {
      const cancel = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
      const cleanup = () => signal?.removeEventListener('abort', cancel);
      signal?.addEventListener('abort', cancel, { once: true });
      void Promise.resolve().then(() => {
        signal?.throwIfAborted();
        return call('cnb_account_get', { ...resource, token: authorization.slice(7) });
      }).then(result => {
        if (signal?.aborted) return;
        const response = new Response([204, 205, 304].includes(result.status) ? null : result.body, {
          status: result.status, headers: result.headers,
        });
        Object.defineProperty(response, 'url', { value: url });
        resolve(response);
      }).catch(() => {
        // Neither Tauri errors nor native transport diagnostics may expose request credentials.
        if (!signal?.aborted) reject(new Error('CNB discovery unavailable'));
      }).finally(cleanup);
    });
  };
}

export const providerFetch = createProviderFetch(
  (url, init) => nativeFetch(url, { ...init, maxRedirections: 0 }),
  (command, args) => invoke<CnbResponse>(command, args),
);
