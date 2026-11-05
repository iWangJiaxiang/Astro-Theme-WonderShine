import type { ProgressCallback } from 'isomorphic-git';
import { NativeAiController } from './native-ai';
import { appDataDir } from '@tauri-apps/api/path';
import { convertFileSrc } from '@tauri-apps/api/core';
import { mkdir } from '@tauri-apps/plugin-fs';
import { fetch as nativeFetch } from '@tauri-apps/plugin-http';
import { createContentTransport } from '../core/transport';
import { validateMediaPath } from '../core/media-validation';
import { setMediaResolver } from '../shared/media';
import { setApiTransport } from '../src/api';
import { tauriFiles } from './tauri-filesystem';
import { FileRepository } from './file-repository';
import { NativeGitEngine } from './git-engine';
import { createGitHttp } from './git-http';
import { validateProfile, validateRemote, type WorkspaceProfile } from './hosting';
import { inspectLocalRepository } from './local-workspace';
import { createLoadDiagnostics } from './load-diagnostics';

export async function connectNativeWorkspace(profile: WorkspaceProfile, token: string, onDisconnect: () => void, onProgress?: ProgressCallback): Promise<() => void> {
  validateProfile(profile, { allowAutomaticBranch: true });
  const base = (await appDataDir()).replace(/\\/g, '/').replace(/\/$/, '');
  await mkdir(base + '/workspaces', { recursive: true });
  const files = tauriFiles(base, profile.source === 'local' ? [profile.localPath!] : []);
  const folder = base + '/workspaces/' + profile.id;
  await mkdir(folder, { recursive: true });
  const root = profile.source === 'local' ? profile.localPath! : folder + '/repo', state = folder + '/state';
  if (profile.source === 'local') {
    const detected = await inspectLocalRepository(files, root);
    Object.assign(profile, { branch: detected.branch, url: detected.url });
  }
  let httpsRemote = false;
  try { validateRemote(profile.url); httpsRemote = true; } catch { /* Local-only and SSH repositories can be edited offline. */ }
  const http = httpsRemote ? createGitHttp(profile.url, (input, init) => nativeFetch(input, { ...init, maxRedirections: 0 }))
    : { request: async (): Promise<never> => { throw new Error('App 同步需要 HTTPS 远端；本地保存和提交仍可使用'); } };
  const git = new NativeGitEngine(files, root, state, profile, http, () => ({ username: profile.username || 'oauth2', password: token }));
  const diagnostics = createLoadDiagnostics(localStorage);
  const progress = diagnostics.progress(onProgress);
  try { await diagnostics.measure('git-open', () => git.open(progress.onProgress)); }
  finally { progress.finish(); }
  const local = new FileRepository(files, root, state, () => git.assertWritable());
  await diagnostics.measure('recovery', () => local.recover());
  const repository = Object.assign(local, { mode: 'git' as const, workspace: git });
  const ai = new NativeAiController(repository, (input, init) => nativeFetch(input, { ...init, maxRedirections: 0 }), localStorage, profile.id);
  let disposed = false;
  const dispose = () => { if (disposed) return; disposed = true; diagnostics.dispose(); ai.dispose(); token = ''; setMediaResolver(); setApiTransport(); };
  const transport = createContentTransport(repository, { ai, identity: { id: profile.id, name: profile.authorName || profile.label }, onLogout: () => {
    dispose(); onDisconnect();
  } });
  setMediaResolver((path, version) => { validateMediaPath(path); return convertFileSrc(root + '/' + path) + `?v=${version}`; });
  setApiTransport((path, init) => {
    if (disposed) return Promise.reject(new Error('连接已更换，请重试'));
    const request = new Request(new URL('/api' + path, 'https://studio.local'), init);
    return request.method === 'GET' && new URL(request.url).pathname === '/api/content'
      ? diagnostics.measure('content-request', () => transport(request))
      : transport(request);
  });
  return dispose;
}
