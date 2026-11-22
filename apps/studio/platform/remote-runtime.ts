import { fetch as nativeFetch } from '@tauri-apps/plugin-http';
import { setApiTransport } from '../src/api';
import { ref } from '../src/reactivity';
import { setMediaResolver, MAX_UPLOAD_SIZE } from '../shared/media';
import { validateMediaPath } from '../core/media-validation';
import { createRemoteTransport } from './remote-transport';
import { readRemoteMedia } from './remote-media';

/** Remote mode has no repository checkout; only editor recovery drafts live locally. */
export async function connectRemoteWorkspace(address: string, onDisconnect: () => void, workspaceId?: string): Promise<() => void> {
  const images = new Map<string, string>();
  const imageVersion = ref(0);
  let generation = 0;
  let mediaRequests = new AbortController();
  const waiting: (() => void)[] = [];
  let active = 0;
  let disposed = false;
  const clear = () => { waiting.length = 0; mediaRequests.abort(); mediaRequests = new AbortController(); generation++; for (const value of images.values()) if (value.startsWith('blob:')) URL.revokeObjectURL(value); images.clear(); imageVersion.value++; };
  const dispose = () => {
    if (disposed) return;
    disposed = true; transport.dispose(); clear(); setMediaResolver(); setApiTransport();
  };
  const transport = createRemoteTransport(address, (input, init) => nativeFetch(input, { ...init, maxRedirections: 0 }), () => { dispose(); onDisconnect(); }, workspaceId);
  try {
    const response = await transport('/auth/config', { method: 'GET' });
    const auth = await response.json();
    if (!response.ok || !auth.password) throw new Error('App 远程连接目前需要启用账号密码登录；OIDC 请使用浏览器登录');
  } catch (error) { transport.dispose(); throw error; }
  setApiTransport((path, init) => { if (path === '/media?refresh=1') clear(); return transport(path, init); });
  const placeholder = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/%3E';
  function pump() {
    while (!disposed && active < 4 && waiting.length) waiting.shift()!();
  }
  setMediaResolver(path => {
    if (disposed) return placeholder;
    void imageVersion.value;
    validateMediaPath(path);
    const cached = images.get(path);
    if (cached) return cached;
    images.set(path, placeholder);
    const current = generation;
    const signal = mediaRequests.signal;
    waiting.push(() => {
      active++;
      void transport(`/media/file?path=${encodeURIComponent(path)}`, { method: 'GET', signal })
        .then(response => readRemoteMedia(response, MAX_UPLOAD_SIZE, signal)).catch(() => null).then(blob => {
          if (current !== generation || disposed) return;
          images.set(path, blob ? URL.createObjectURL(blob) : 'data:,');
          imageVersion.value++;
        }).finally(() => { active--; pump(); });
    });
    pump();
    return placeholder;
  });
  return dispose;
}
