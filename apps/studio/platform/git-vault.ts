import { StudioError } from '../core/errors';
import { invoke } from '@tauri-apps/api/core';
import type { WorkspaceProfile } from './hosting';
import { isOAuthRemote, renewGitGrant, type GitGrant } from './provider-auth';
import type { WorkspaceOAuthCredential } from './git-credential';
import { providerFetch } from './provider-fetch';

async function accountKey(profile: WorkspaceProfile) {
  const identity = [profile.id, profile.url, profile.provider, profile.username];
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(identity)));
  return 'git-' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function vault<T>(command: string, args: Record<string, unknown>) {
  try { return await invoke<T>('plugin:keyring-store|' + command, args); }
  catch { throw new StudioError(409, '无法访问系统凭据存储，请解锁设备后重试。'); }
}
export async function forgetGitGrant(profile: WorkspaceProfile) {
  await vault('delete_passwords', { accounts: [await accountKey(profile)] });
}
export function workspaceCredential(profile: WorkspaceProfile, initial?: GitGrant) {
  const account = accountKey(profile), lifecycle = new AbortController();
  let current = initial, loaded = !!initial;
  let rotated: GitGrant | undefined;
  let queue = Promise.resolve();
  function run<T>(action: () => Promise<T>) {
    const result = queue.then(() => { lifecycle.signal.throwIfAborted(); return action(); });
    queue = result.then(() => {}, () => {});
    return result;
  }
  async function store(grant: GitGrant) {
    lifecycle.signal.throwIfAborted();
    await vault('set_passwords', { entries: [{ account: await account, secret: JSON.stringify(grant) }] });
    lifecycle.signal.throwIfAborted();
    current = grant; loaded = true; rotated = undefined;
  }
  const { provider, url, username } = profile;
  const oauth: WorkspaceOAuthCredential | undefined = username && isOAuthRemote(provider, url) ? {
    provider,
    authorize: (account) => run(async () => {
      if (account.provider !== provider || account.username !== username) throw new StudioError(403, '请使用此工作区原来的 Git 账号重新登录');
      const { token, refreshToken, expiresAt, refreshExpiresAt, clientId } = account;
      await store({ token, refreshToken, expiresAt, refreshExpiresAt, clientId });
    }),
  } : undefined;
  return {
    id: profile.id, oauth, hasToken: () => !!current?.token,
    set: (token: string) => run(async () => {
      if (token) await store({ token });
      else { await forgetGitGrant(profile); current = rotated = undefined; loaded = true; }
    }),
    persistInitial: () => run(async () => { if (initial && current) await store(current); initial = undefined; }),
    password: () => run(async () => {
      if (rotated) await store(rotated);
      if (!loaded) {
        const [saved] = await vault<(string | null)[]>('get_passwords', { accounts: [await account] });
        if (saved) current = JSON.parse(saved) as GitGrant;
        loaded = true;
      }
      if (!current) return '';
      if (current.expiresAt != null && current.expiresAt <= Date.now() + (current.refreshToken ? 60_000 : 0)) {
        if ((provider !== 'github' && provider !== 'cnb') || !current.refreshToken) throw new StudioError(403, '授权已过期，请重新登录');
        const renewed = await renewGitGrant(provider, current, providerFetch, lifecycle.signal).catch(error => {
          lifecycle.signal.throwIfAborted();
          throw new StudioError(403, error instanceof Error ? error.message : '授权已过期，请重新登录', { gitAuth: 1 });
        });
        // Keep a rotated grant available if the system store is temporarily locked.
        rotated = renewed;
        await store(renewed);
      }
      return current.token;
    }),
    dispose() { lifecycle.abort(); current = initial = rotated = undefined; },
  };
}
