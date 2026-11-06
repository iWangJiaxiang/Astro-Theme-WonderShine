import { ref, watch } from './reactivity';
import { InflightQuery } from './inflight-query';
import { locale, type Message } from './i18n';
import type { MessageParams } from '../shared/i18n';
import type { Identity } from '../shared/types.js';
export const session = ref<{ identity: Identity; csrf: string; expires: number } | null>(null);
export const reauthentication = ref(false);
export class ApiError extends Error { constructor(message: string, public status: number, public params?: MessageParams) { super(message); } }
export type ApiTransport = (path: string, init: RequestInit) => Promise<Response>;
let transport: ApiTransport = (path, init) => fetch(`/api${path}`, init);
const contentQueries = new InflightQuery();
let transportGeneration = 0;
let scopeGeneration = 0;
watch(() => [session.value, session.value?.identity.id, session.value?.identity.method, session.value?.csrf, session.value?.expires, locale.value] as const,
  () => { scopeGeneration++; contentQueries.invalidate(); });
export function setApiTransport(next?: ApiTransport) {
  transport = next || ((path, init) => fetch(`/api${path}`, init));
  transportGeneration++;
  contentQueries.invalidate();
}
export const pendingMutations = ref(0);
let loggingOut = false;
let mutationsIdle = Promise.resolve();
let finishMutations: (() => void) | undefined;
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const mutation = method !== 'GET';
  const logout = path === '/auth/logout';
  if (loggingOut || (logout && pendingMutations.value > 0)) throw new ApiError('正在保存或生成译文，请稍候。', 409);
  if (logout) loggingOut = true;
  if (mutation) {
    if (pendingMutations.value === 0) mutationsIdle = new Promise(resolve => { finishMutations = resolve; });
    pendingMutations.value++;
    contentQueries.invalidate();
  }
  try {
    if (method === 'GET' && body === undefined && path.split('?')[0] === '/content') {
      const activeScope = scopeGeneration;
      const activeTransportGeneration = transportGeneration;
      const assertCurrent = () => {
        if (activeTransportGeneration !== transportGeneration || activeScope !== scopeGeneration || loggingOut) {
          throw new ApiError('连接已更换，请重试', 409);
        }
      };
      const query = new URLSearchParams(path.split('?')[1]);
      const refresh = query.getAll('refresh').includes('1');
      query.delete('refresh');
      query.sort();
      try {
        const result = await contentQueries.read<T>(query.toString(), async (signal, isCurrent) => {
          // Reads overlapping writes must observe the final mutation boundary.
          while (pendingMutations.value > 0) { await mutationsIdle; assertCurrent(); signal.throwIfAborted(); }
          assertCurrent();
          signal.throwIfAborted();
          // The helper retries obsolete work; do not issue a redundant read after a write.
          if (!isCurrent()) throw new Error('Content query superseded');
          // Keep this caller's original refresh=1 on every retry. The helper
          // must not satisfy a forced loader with an ordinary pending read.
          return request<T>(path, method, body, signal);
        }, { refresh, assertCurrent });
        assertCurrent();
        return result;
      } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') throw new ApiError('连接超时，请重试。', 408);
        throw error;
      }
    }
    return await request<T>(path, method, body);
  } finally {
    if (mutation) {
      contentQueries.invalidate();
      pendingMutations.value--;
      if (pendingMutations.value === 0) { finishMutations?.(); finishMutations = undefined; }
    }
    if (logout) loggingOut = false;
  }
}
async function request<T>(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const binary = body instanceof Blob;
  let response: Response;
  const activeTransport = transport;
  const activeTransportGeneration = transportGeneration;
  const activeScope = scopeGeneration;
  try { response = await activeTransport(path, { method, credentials: 'same-origin',
    ...(method === 'GET' ? { signal: signal || AbortSignal.timeout(60_000) } : {}),
    headers: { 'Accept-Language': locale.value, ...(body === undefined ? {} : { 'Content-Type': binary ? 'application/octet-stream' : 'application/json' }), ...(session.value ? { 'X-CSRF-Token': session.value.csrf } : {}) },
    body: body === undefined ? undefined : binary ? body : JSON.stringify(body) });
  } catch (error) {
    if (method !== 'GET') throw error;
    throw new ApiError(error instanceof Error && error.name === 'TimeoutError' ? '连接超时，请重试。' : '网络连接失败，请检查网络后重试。', 408);
  }
  signal?.throwIfAborted();
  if ((activeTransportGeneration !== transportGeneration || (method === 'GET' && activeScope !== scopeGeneration)) && path !== '/auth/logout') throw new ApiError('连接已更换，请重试', 409);
  const data = await response.json().catch(() => { throw new ApiError(response.status === 413 ? '文件超过服务器上传限制，请选择较小的图片' : '请求失败，请稍后再试', response.ok ? 502 : response.status); });
  signal?.throwIfAborted();
  if ((activeTransportGeneration !== transportGeneration || (method === 'GET' && activeScope !== scopeGeneration)) && path !== '/auth/logout') throw new ApiError('连接已更换，请重试', 409);
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/login' && session.value) reauthentication.value = true;
    throw new ApiError(data.messageKey || data.error || '请求失败，请稍后再试', response.status, data.params);
  }
  return data as T;
}
export const errorMessage = (error: unknown): Message => error instanceof ApiError ? { key: error.message, params: error.params } : error instanceof Error ? error.message : '操作失败';
