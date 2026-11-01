/** Git transport is independent of provider-specific discovery and deployment APIs. */
export type HostingKind = 'generic' | 'github' | 'gitlab' | 'cnb' | 'gitee' | 'gitea' | 'forgejo';
export interface HostingCapabilities { git: true; discovery: boolean; pullRequests: boolean; deploymentStatus: boolean }
export interface HostingProvider {
  id: HostingKind;
  label: string;
  capabilities: HostingCapabilities;
  validateRemote(value: string): URL;
}
export function validateRemote(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('请输入完整的 HTTPS Git 仓库地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname === '/' || /[\x00-\x20\x7f]/.test(value)) {
    throw new Error('Git 地址必须使用 HTTPS，且不能包含密码、查询参数或片段');
  }
  return url;
}
export function validateBranch(branch: string): string {
  if (!branch || branch === '@' || branch.startsWith('-') || /[\s~^:?*\[\\\x00-\x1f\x7f]/.test(branch)
    || branch.includes('..') || branch.includes('@{') || branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) {
    throw new Error('Git 分支名称无效');
  }
  return branch;
}
const names: Record<HostingKind, string> = { generic: '通用 Git', github: 'GitHub', gitlab: 'GitLab', cnb: 'CNB', gitee: 'Gitee', gitea: 'Gitea', forgejo: 'Forgejo' };
export const hostingProviders: HostingProvider[] = Object.entries(names).map(([id, label]) => ({
  id: id as HostingKind, label, validateRemote,
  // Protocol access works without claiming unimplemented provider APIs.
  capabilities: { git: true, discovery: false, pullRequests: false, deploymentStatus: false },
}));
export interface WorkspaceProfile {
  id: string; label: string; provider: HostingKind; url: string; branch: string;
  username: string; authorName: string; authorEmail: string;
  source?: 'local' | 'clone'; localPath?: string;
}
export function validateProfile(profile: WorkspaceProfile, options: { allowAutomaticBranch?: boolean } = {}): WorkspaceProfile {
  if (!/^[0-9a-f-]{36}$/.test(profile.id) || !hostingProviders.some(item => item.id === profile.provider)) throw new Error('工作区设置无效');
  if (profile.source !== undefined && !['local', 'clone'].includes(profile.source)) throw new Error('工作区设置无效');
  if (profile.source === 'local') {
    validateLocalPath(profile.localPath || '');
    if (profile.url.includes('://')) {
      const remote = new URL(profile.url);
      if (remote.password || (['https:', 'http:'].includes(remote.protocol) && remote.username) || remote.search || remote.hash) throw new Error('请先从 Git 远端地址中移除嵌入的凭据');
    }
  }
  else validateRemote(profile.url);
  // Empty branch is permitted only while preparing a new clone, never in saved profiles.
  if (!(options.allowAutomaticBranch && profile.source !== 'local' && profile.branch === '')) validateBranch(profile.branch);
  if (!profile.label?.trim() || ![profile.label, profile.url, profile.username, profile.authorName, profile.authorEmail].every(value => typeof value === 'string' && !/[\r\n\x00]/.test(value))) throw new Error('工作区设置无效');
  return profile;
}

export function validateLocalPath(value: string): string {
  const path = value.replace(/\\/g, '/').replace(/\/$/, '');
  if (!/^(\/|[a-z]:\/)/i.test(path) || path === '/' || /^[a-z]:$/i.test(path) || !path || /[\x00-\x1f]/.test(path)
    || path.split('/').some(part => part === '..' || part === '.')) throw new Error('请选择有效的本地仓库文件夹');
  return path;
}
