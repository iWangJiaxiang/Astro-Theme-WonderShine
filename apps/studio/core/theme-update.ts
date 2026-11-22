import { parse } from 'smol-toml';
import type { Repository } from '../shared/repository.js';
import type { ThemeUpdateCheck, ThemeUpdateResult } from '../shared/theme-update.js';
import { getValue, patchToml } from './content.js';
import { StudioError } from './errors.js';
import { channelPath, pinPath, versionPath, isThemeChannelVersion, resolveThemeVersion, themeChannel } from './theme-channel.js';

export const themeConfigPath = 'config.toml';
const rebuildPrefix = '# WonderShine Studio theme rebuild: ';

export function themeRebuildComment(source: string, channel: string, now: Date): string {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = source.slice(bom.length);
  const firstEnd = body.indexOf('\n');
  const original = body.startsWith(rebuildPrefix) ? firstEnd === -1 ? '' : body.slice(firstEnd + 1) : body;
  const line = (time: Date) => rebuildPrefix + channel + ' ' + time.toISOString() + newline;
  const current = line(now);
  return bom + (body.startsWith(current) ? line(new Date(now.getTime() + 1)) : current) + original;
}

async function readTheme(repository: Repository) {
  const file = await repository.read(themeConfigPath);
  const data = file ? parse(file.text) : {};
  const channel = themeChannel(getValue(data, channelPath));
  const pin = getValue(data, pinPath), version = getValue(data, versionPath);
  if (pin !== undefined && typeof pin !== 'boolean') throw new StudioError(400, '固定版本设置无效');
  const pinned = pin === true;
  return { file, channel, pinned, currentVersion: pinned && typeof version === 'string' && version ? version : null };
}

export async function checkThemeUpdate(repository: Repository, request: typeof fetch): Promise<ThemeUpdateCheck> {
  const { file, channel, pinned, currentVersion } = await readTheme(repository);
  const channelVersion = await resolveThemeVersion(channel, request);
  const destination = repository.workspace?.commitTheme ? 'workspace' : repository.mode === 'git' && !repository.workspace ? 'remote' : 'file';
  return { revision: file?.revision ?? null, channel, pinned, currentVersion, channelVersion, destination };
}

// Git uses the SHA-1 of the typed blob and its byte length for object identity.
export async function themeBlobId(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const input = encoder.encode(`blob ${encoder.encode(text).length}\0${text}`);
  const digest = await crypto.subtle.digest('SHA-1', input);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function applyThemeUpdate(repository: Repository, request: typeof fetch, now: Date, input: unknown): Promise<ThemeUpdateResult> {
  if (!input || typeof input !== 'object' || !('revision' in input) || !('channelVersion' in input)
    || (input.revision !== null && typeof input.revision !== 'string') || typeof input.channelVersion !== 'string') {
    throw new StudioError(400, '请先检查主题更新');
  }
  const { file, channel, pinned, currentVersion } = await readTheme(repository);
  const revision = file?.revision ?? null;
  if (input.revision !== revision) throw new StudioError(409, '主题设置已变化，请重新检查更新');
  if (!isThemeChannelVersion(channel, input.channelVersion)) throw new StudioError(400, '请先检查主题更新');
  if (pinned) {
    const target = await resolveThemeVersion(channel, request);
    if (input.channelVersion !== target) throw new StudioError(409, '渠道版本已变化，请重新检查更新');
    if (currentVersion === target) return { revision: revision ?? '', pinnedThemeVersion: target, message: '已是该渠道当前版本' };
  }

  const workspace = repository.workspace;
  const status = workspace?.commitTheme ? await workspace.status() : undefined;
  if (status && (!status.head || status.managedChanges?.includes(themeConfigPath))) {
    throw new StudioError(409, '请先处理 config.toml 中尚未提交的修改，再更新主题');
  }
  const source = file?.text ?? '';
  const text = pinned ? patchToml(source, { [versionPath]: input.channelVersion }) : themeRebuildComment(source, channel, now);
  const commitMessage = pinned ? `chore(theme): pin ${channel} to ${input.channelVersion}` : `chore(theme): rebuild from ${channel}`;
  const saved = await repository.writeBatch([{ path: themeConfigPath, text, expectedRevision: revision, commitMessage }]);
  const result = { ...saved, ...(pinned && { pinnedThemeVersion: input.channelVersion }) };
  if (status?.head && workspace?.commitTheme) {
    try {
      const [before, after] = await Promise.all([file ? themeBlobId(source) : null, themeBlobId(text)]);
      const commit = await workspace.commitTheme({ head: status.head, before, after, message: commitMessage });
      return { ...result, commit, message: '主题更新已提交到本地 Git，等待同步' };
    } catch {
      return { ...result, localCommitPending: true, message: '主题配置已写入，提交未确认。请到工作区核对。' };
    }
  }
  return { ...result, message: saved.commit ? '主题更新已推送。请在站点部署平台查看构建结果。' : '主题配置已写入。请提交并推送到部署分支。' };
}
