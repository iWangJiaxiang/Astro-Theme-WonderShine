import { parse } from 'smol-toml';
import type { ArticleReference, ContentLanguages, FileSnapshot } from '../shared/types.js';
import { translationLocation } from '../shared/translation.js';
import { getValue, splitDocument } from './content.js';
import { validatePath, type Repository } from '../shared/repository.js';
import { StudioError } from './errors.js';

const isArticle = (path: string) => /^content\/(articles|collections)\//.test(path) && !path.startsWith('content/collections/album/') && !/\/_index(?:\.[A-Za-z0-9-]+)?\.md$/.test(path);
function references(file: Pick<FileSnapshot, 'path' | 'text'>, languages: ContentLanguages): ArticleReference[] {
  const value = getValue(parse(splitDocument(file.text).header), 'extra.references');
  if (value === undefined) return [];
  const invalid = () => new StudioError(400, '引用文章格式不正确，请重新选择文章或填写有效的 HTTP(S) 地址');
  if (!Array.isArray(value) || value.length > 12) throw invalid();
  const seen = new Set<string>();
  for (const reference of value) {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)) throw invalid();
    let identity: string;
    if (reference.kind === 'internal') {
      if (typeof reference.path !== 'string' || !/^(articles|collections)\//.test(reference.path)) throw invalid();
      const path = `content/${reference.path}`;
      validatePath(path);
      if (!isArticle(path) || translationLocation(path, languages.defaultLanguage, languages).translationKey !== path || Object.keys(reference).some(key => !['kind', 'path'].includes(key))) throw invalid();
      identity = `internal:${path}`;
    } else if (reference.kind === 'external') {
      if (typeof reference.url !== 'string' || reference.url.length > 2048 || /[\x00-\x20\x7f]/.test(reference.url) || typeof reference.title !== 'string' || reference.title.length > 300 || Object.keys(reference).some(key => !['kind', 'url', 'title'].includes(key))) throw invalid();
      let url: URL;
      try { url = new URL(reference.url); } catch { throw invalid(); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw invalid();
      identity = `external:${url.href}`;
    } else throw invalid();
    if (seen.has(identity)) throw invalid();
    seen.add(identity);
  }
  return value as ArticleReference[];
}

export async function validateArticleReferences(repository: Repository, path: string, text: string | null, languages: ContentLanguages): Promise<void> {
  if (text === null && !isArticle(path)) return;
  if (text !== null) {
    const links = references({ path, text }, languages).filter(ref => ref.kind === 'internal');
    if (!links.length) return;
    const files = await repository.list();
    for (const ref of links) {
      const matches = files.filter(file => isArticle(file.path) && translationLocation(file.path, languages.defaultLanguage, languages).translationKey === `content/${ref.path}`);
      if (!matches.length) throw new StudioError(400, '引用的本站文章不存在：{path}', { path: ref.path });
      for (const match of matches) parse(splitDocument(match.text).header);
    }
    return;
  }
  const identity = translationLocation(path, languages.defaultLanguage, languages).translationKey;
  const remaining = (await repository.list()).filter(file => file.path !== path);
  if (remaining.some(file => isArticle(file.path) && translationLocation(file.path, languages.defaultLanguage, languages).translationKey === identity)) return;
  for (const file of remaining) {
    if (references(file, languages).some(ref => ref.kind === 'internal' && `content/${ref.path}` === identity)) throw new StudioError(409, '文章仍被 {path} 引用，请先移除引用再删除最后一个语言版本', { path: file.path });
  }
}
