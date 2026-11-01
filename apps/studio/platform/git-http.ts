import type { HttpClient } from 'isomorphic-git';
import { validateRemote } from './hosting';
export function createGitHttp(remote: string, requestFetch: typeof fetch): HttpClient {
  const origin = validateRemote(remote).origin;
  return { request: async request => {
    const url = new URL(request.url);
    if (url.origin !== origin || url.username || url.password) throw new Error('Git 请求不能越过配置的仓库域名');
    const chunks: Uint8Array[] = [];
    if (request.body) for await (const chunk of request.body) chunks.push(chunk);
    const body = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    const response = await requestFetch(request.url, { method: request.method, headers: request.headers, redirect: 'error',
      ...(body.length ? { body } : {}), signal: AbortSignal.timeout(60_000) });
    if (response.status >= 300 && response.status < 400 || response.url && new URL(response.url).origin !== origin) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Git 不允许重定向凭据');
    }
    // Git retries authentication challenges without consuming their bodies.
    // Release these native response resources before returning the status.
    if (response.status !== 200) await response.body?.cancel().catch(() => {});
    return { url: request.url, method: request.method || 'GET', statusCode: response.status, statusMessage: response.statusText,
      headers: Object.fromEntries(response.headers), body: (async function* () {
        if (response.status !== 200) return;
        const reader = response.body?.getReader();
        if (!reader) return;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) return;
            yield value;
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      })() };
  } };
}
