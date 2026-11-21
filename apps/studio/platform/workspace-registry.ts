import { validateLocalPath, validateProfile, validateRemote, type WorkspaceProfile } from './hosting';

export const workspaceStorageKey = 'wondershine.native.workspaces.v1';
export interface ServiceWorkspace { id: string; label: string; source: 'service'; address: string }
export type SavedWorkspace = (WorkspaceProfile | ServiceWorkspace) & { archived?: boolean };
export function serviceAddress(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('请输入不含路径的 HTTPS 创作中心地址');
  return url.origin;
}
/** Keep the saved URL and ID because the checkout, drafts and Git state use them. */
export function matchWorkspace(records: SavedWorkspace[], candidate: SavedWorkspace): SavedWorkspace | undefined {
  const selected = records.find(item => item.id === candidate.id);
  if (selected) return selected;
  let matches: SavedWorkspace[];
  if (candidate.source === 'service') {
    const origin = serviceAddress(candidate.address);
    matches = records.filter(item => item.source === 'service' && item.address === origin);
  } else if (candidate.source === 'local') {
    const path = validateLocalPath(candidate.localPath || '');
    matches = records.filter(item => item.source === 'local' && validateLocalPath(item.localPath || '') === path);
  } else {
    const remote = (url: string) => validateRemote(url).href.replace(/\/$/, '');
    const url = remote(candidate.url);
    matches = records.filter(item => item.source !== 'service' && item.source !== 'local' &&
      remote(item.url) === url && (!candidate.branch || item.branch === candidate.branch));
  }
  if (matches.length > 1) throw new Error('找到多个匹配的工作区，请从工作区列表选择。');
  return matches[0];
}
export function cleanWorkspace(record: SavedWorkspace): SavedWorkspace {
  if (!record || !/^[0-9a-f-]{36}$/.test(record.id) || typeof record.label !== 'string' || !record.label.trim()) throw new Error('工作区设置无效');
  const archived = record.archived === true ? { archived: true } : {};
  if (record.source === 'service') return { ...archived, id: record.id, label: record.label.trim(), source: 'service', address: serviceAddress(record.address) };
  validateProfile(record);
  const { id, label, provider, url, branch, username, authorName, authorEmail, source, localPath } = record;
  return { ...archived, id, label, provider, url, branch, username, authorName, authorEmail, ...(source ? { source } : {}), ...(source === 'local' ? { localPath } : {}) };
}
export function readWorkspaces(storage: Pick<Storage, 'getItem'>): SavedWorkspace[] {
  const data: unknown = JSON.parse(storage.getItem(workspaceStorageKey) || '[]');
  if (!Array.isArray(data)) throw new Error('工作区设置无效');
  const records = data.map(cleanWorkspace);
  if (new Set(records.map(record => record.id)).size !== records.length) throw new Error('工作区设置无效');
  return records;
}
export function writeWorkspaces(storage: Pick<Storage, 'setItem'>, records: SavedWorkspace[]): void {
  const clean = records.map(cleanWorkspace);
  if (new Set(clean.map(record => record.id)).size !== clean.length) throw new Error('工作区设置无效');
  storage.setItem(workspaceStorageKey, JSON.stringify(clean));
}
