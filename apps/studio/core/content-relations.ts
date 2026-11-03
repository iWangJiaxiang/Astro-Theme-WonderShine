import { parse } from 'smol-toml';
import type { FileSnapshot } from '../shared/types.js';
import type { Repository } from '../shared/repository.js';
import { getValue, splitDocument } from './content.js';
import { threadLanguages } from './threads.js';
import { topicPath, validateTopic } from './topics.js';
import { StudioError } from './errors.js';
import { validateArticleReferences } from './article-references.js';

const isTopic = (path: string) => /^content\/topics\/[^/]+\/index(?:\.[A-Za-z0-9-]+)?\.md$/.test(path);
function metadata(file: Pick<FileSnapshot, 'path' | 'text'>) {
  try { return parse(splitDocument(file.text).header); }
  catch { throw new StudioError(400, '内容文件 {path} 的 TOML 格式需要检查', { path: file.path }); }
}
function topicIds(file: Pick<FileSnapshot, 'path' | 'text'>): string[] {
  const value = getValue(metadata(file), 'extra.topics');
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) || new Set(value).size !== value.length) throw new StudioError(400, '内容 {path} 的话题关联必须为不重复的有效 ID 列表', { path: file.path });
  return value as string[];
}

// Called inside Repository.write's lock, so association writes cannot race topic mutations.
export async function validateContentRelations(repository: Repository, path: string, text: string | null): Promise<void> {
  const configFile = await repository.read('config.toml');
  const languages = threadLanguages(configFile ? parse(configFile.text) : {});
  await validateArticleReferences(repository, path, text, languages);
  if (text === null && !isTopic(path)) return;
  if (text === null) {
    const removed = topicPath(path, languages);
    const remaining = (await repository.list()).filter(file => file.path !== path);
    const sibling = remaining.find(file => isTopic(file.path) && file.path.startsWith(`content/topics/${removed.id}/`));
    if (sibling) { validateTopic(sibling, languages); return; }
    for (const file of remaining) {
      if (topicIds(file).includes(removed.id)) throw new StudioError(409, '话题 {id} 仍被内容关联，请先移除 {path} 中的关联', { id: removed.id, path: file.path });
    }
    return;
  }
  const candidate = { path, text };
  const ids = topicIds(candidate);
  if (isTopic(path)) {
    const identity = validateTopic(candidate, languages);
    const siblings = (await repository.list()).filter(file => file.path !== path && isTopic(file.path) && file.path.startsWith(`content/topics/${identity.id}/`));
    for (const sibling of siblings) if (validateTopic(sibling, languages).date !== identity.date) throw new StudioError(409, '话题译文必须保留原话题的创建时间，请重新加载后保存');
  }
  if (!ids.length) return;
  const topics = (await repository.list()).filter(file => file.path !== path && isTopic(file.path));
  if (isTopic(path)) topics.push({ ...candidate, revision: '' });
  for (const id of ids) {
    const matches = topics.filter(file => file.path.startsWith(`content/topics/${id}/`));
    if (!matches.length) throw new StudioError(400, '内容 {path} 的关联话题 {id} 不存在', { path, id });
    // Language and draft status affect public visibility, never logical association validity.
    for (const match of matches) validateTopic(match, languages);
  }
}
