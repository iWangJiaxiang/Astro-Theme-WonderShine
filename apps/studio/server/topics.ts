import { parse } from 'smol-toml';
import type { ContentLanguages, FileSnapshot, Json } from '../shared/types.js';
import type { Repository } from './repository.js';
import { formDocumentMetadata, splitDocument, getValue } from './content.js';
import { noteLanguages } from './notes.js';
import { StudioError } from './errors.js';

export function topicPath(path: string, languages: ContentLanguages) {
  const match = path.match(/^content\/topics\/([a-zA-Z0-9][a-zA-Z0-9_-]*)\/index(?:\.([A-Za-z0-9-]+))?\.md$/);
  if (!match) throw new StudioError(400, '话题路径必须为 content/topics/<id>/index.md 或语言版本');
  const lang = match[2] || languages.defaultLanguage;
  if (!languages.languages.includes(lang) || match[2] === languages.defaultLanguage) throw new StudioError(400, '话题语言未配置，默认语言请使用 index.md');
  return { id: match[1], lang };
}
export function topicMetadata(file: Pick<FileSnapshot, 'path' | 'text'>): Record<string, unknown> {
  try { return formDocumentMetadata(splitDocument(file.text).header); }
  catch { throw new StudioError(400, '话题文件 {path} 的 TOML 格式需要检查', { path: file.path }); }
}

export async function topicChanges(repository: Repository, path: string, current: FileSnapshot | null, changes: Record<string, Json>, now: Date): Promise<Record<string, Json>> {
  const config = await repository.read('config.toml');
  const languages = noteLanguages(config ? parse(config.text) : {});
  const location = topicPath(path, languages);
  const existing = current ? topicMetadata(current) : undefined;
  const siblings = current ? [] : (await repository.list()).filter(file => file.path !== path && file.path.startsWith(`content/topics/${location.id}/index`));
  const sibling = siblings[0] ? topicMetadata(siblings[0]) : undefined;
  return { 'extra.kind': 'topic', 'extra.id': location.id, layout: 'topic', ...changes,
    date: String(existing?.date ?? sibling?.date ?? now.toISOString()), updated: now.toISOString() };
}

export function validateTopic(file: Pick<FileSnapshot, 'path' | 'text'>, languages: ContentLanguages) {
  const location = topicPath(file.path, languages);
  const metadata = topicMetadata(file);
  if (getValue(metadata, 'extra.kind') !== 'topic' || getValue(metadata, 'extra.id') !== location.id) throw new StudioError(400, '话题文件 {path} 的 kind 必须为 topic，id 必须与目录一致', { path: file.path });
  if (typeof metadata.title !== 'string' || !metadata.title.trim()) throw new StudioError(400, '请填写话题标题');
  if (metadata.layout !== 'topic') throw new StudioError(400, '话题文件 {path} 只能使用 topic 模板', { path: file.path });
  if (metadata.path !== undefined && metadata.path !== '') throw new StudioError(400, '话题文件 {path} 不允许自定义公开路径', { path: file.path });
  if (metadata.slug !== undefined && metadata.slug !== '' && metadata.slug !== location.id) throw new StudioError(400, '话题文件 {path} 的 slug 必须与目录 id 一致', { path: file.path });
  for (const key of ['date', 'updated']) {
    const value = String(metadata[key] ?? '');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new StudioError(400, '话题文件 {path} 的创建和更新时间必须包含完整时间和时区', { path: file.path });
  }
  return { ...location, date: Date.parse(String(metadata.date)) };
}
