import type { ProgressCallback } from 'isomorphic-git';
import { NativeAiController } from './native-ai';
import { appDataDir } from '@tauri-apps/api/path';
import { convertFileSrc } from '@tauri-apps/api/core';
import { mkdir } from '@tauri-apps/plugin-fs';
import { fetch as nativeFetch } from '@tauri-apps/plugin-http';
import { createContentTransport } from '../core/transport';
import { createSummaryRuntime } from '../core/summary-runtime';
import type { SummaryIndexStore } from '../core/summary-index';
import { createNativeSummaryStore } from './summary-store';
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
import { nativeReviewSource, openNativeWorkspaceReviews } from './review-store';
import { ensureDirectory } from './filesystem';

export async function connectNativeWorkspace(profile: WorkspaceProfile, token: string, onDisconnect: () => void, onProgress?: ProgressCallback, summaryStore?: SummaryIndexStore): Promise<() => void> {
  validateProfile(profile, { allowAutomaticBranch: true });
  const base = (await appDataDir()).replace(/\\/g, '/').replace(/\/$/, '');
  const files = tauriFiles(base, profile.source === 'local' ? [profile.localPath!] : []);
  const folder = base + '/workspaces/' + profile.id;
  const root = profile.source === 'local' ? profile.localPath! : folder + '/repo', state = folder + '/state';
  const checkoutRoot = root.replace(/\\/g, '/').replace(/\/$/, '');
  if (state === checkoutRoot || state.startsWith(checkoutRoot + '/') || checkoutRoot.startsWith(state + '/')) {
    throw new Error('Git 工作区与状态目录必须分开存储');
  }
  await mkdir(base, { recursive: true });
  await ensureDirectory(files, folder);
  if (profile.source === 'local') {
    const detected = await inspectLocalRepository(files, root);
    Object.assign(profile, { branch: detected.branch, url: detected.url });
  }
  let httpsRemote = false;
  try { validateRemote(profile.url); httpsRemote = true; } catch { /* Local-only and SSH repositories can be edited offline. */ }
  const http = httpsRemote ? createGitHttp(profile.url, (input, init) => nativeFetch(input, { ...init, maxRedirections: 0 }))
    : { request: async (): Promise<never> => { throw new Error('App 同步需要 HTTPS 远端；本地保存和提交仍可使用'); } };
  // Recover derived review locks only under the process-lifetime native owner,
  // before opening Git or exposing any workspace operation to the transport.
  await ensureDirectory(files, state);
  const reviewStore = await openNativeWorkspaceReviews(state, base);
  const git = new NativeGitEngine(files, root, state, profile, http, () => ({ username: profile.username || 'oauth2', password: token }), {
    store: reviewStore, source: nativeReviewSource(root),
  });
  const diagnostics = createLoadDiagnostics(localStorage);
  const progress = diagnostics.progress(onProgress);
  try { await diagnostics.measure('git-open', () => git.open(progress.onProgress)); }
  finally { progress.finish(); }
  const local = new FileRepository(files, root, state, () => git.assertWritable());
  await diagnostics.measure('recovery', () => local.recover());
  const repository = Object.assign(local, { mode: 'git' as const, workspace: git });
  // Bind persisted projections to the actual checkout, not merely a recent-list ID.
  const summaryScope = JSON.stringify(['native-summary-v1', profile.id, profile.source ?? 'clone', root, profile.url, profile.branch]);
  if (!summaryStore) {
    try { summaryStore = createNativeSummaryStore(files, state, base); }
    catch { /* Optional preview storage must not prevent opening a workspace. */ }
  }
  const runtime = createSummaryRuntime(repository, { scope: summaryScope, store: summaryStore });
  const ai = new NativeAiController(runtime.repository, (input, init) => nativeFetch(input, { ...init, maxRedirections: 0 }), localStorage, profile.id);
  let disposed = false;
  const dispose = () => { if (disposed) return; disposed = true; diagnostics.dispose(); ai.dispose(); runtime.dispose(); token = ''; setMediaResolver(); setApiTransport(); };
  const transport = createContentTransport(repository, { runtime, ai, aiUsesObservedRepository: true, identity: { id: profile.id, name: profile.authorName || profile.label }, onLogout: () => {
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
