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
  let disposed = false;
  const clear = () => { mediaRequests.abort(); mediaRequests = new AbortController(); generation++; for (const value of images.values()) if (value.startsWith('blob:')) URL.revokeObjectURL(value); images.clear(); imageVersion.value++; };
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
  setMediaResolver(path => {
    if (disposed) return placeholder;
    void imageVersion.value;
    validateMediaPath(path);
    const cached = images.get(path);
    if (cached) return cached;
    images.set(path, placeholder);
    const current = generation;
    const signal = mediaRequests.signal;
    void transport(`/media/file?path=${encodeURIComponent(path)}`, { method: 'GET', signal }).then(async response => {
      const blob = await readRemoteMedia(response, MAX_UPLOAD_SIZE, signal);
      if (!blob || current !== generation || disposed) return;
      images.set(path, URL.createObjectURL(blob));
      imageVersion.value++;
    }).catch(() => { /* A failed image does not invalidate the editing session. */ });
    return placeholder;
  });
  return dispose;
}
