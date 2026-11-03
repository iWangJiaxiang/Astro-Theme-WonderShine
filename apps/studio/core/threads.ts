import { parse } from 'smol-toml';
import type { FileSnapshot, Json } from '../shared/types.js';
import type { WriteGuard } from '../shared/repository.js';
import { getValue, splitDocument, formDocumentMetadata } from './content.js';
import type { ContentLanguages } from '../shared/types.js';
import { StudioError } from './errors.js';
import { canonicalNativeThreadRoute } from '../shared/thread-routes.js';

export function threadLanguages(config: Record<string, unknown>): ContentLanguages {
  const defaultLanguage = typeof config.default_language === 'string' ? config.default_language : 'en';
  const configured = config.languages && typeof config.languages === 'object' ? Object.keys(config.languages) : [];
  return { defaultLanguage, languages: [...new Set([defaultLanguage, ...configured])] };
}
export function threadPath(path: string, languages: ContentLanguages) {
  const match = path.match(/^content\/threads\/([a-zA-Z0-9][a-zA-Z0-9_-]*)\/index(?:\.([A-Za-z0-9-]+))?\.md$/);
  if (!match) throw new StudioError(400, '动态路径必须为 content/threads/<id>/index.md 或语言版本');
  const lang = match[2] || languages.defaultLanguage;
  if (!languages.languages.includes(lang) || match[2] === languages.defaultLanguage) throw new StudioError(400, '动态语言未配置，默认语言请使用 index.md');
  return { id: match[1], lang };
}


export function threadMetadata(file: Pick<FileSnapshot, 'path' | 'text'>): Record<string, unknown> {
  try { return formDocumentMetadata(splitDocument(file.text).header); }
  catch { throw new StudioError(400, '动态文件 {path} 的 TOML 格式需要检查', { path: file.path }); }
}

const route = (path: string) => '/' + path.replace(/^\/+|\/+$/g, '') + '/';

/** System-maintained routes do not create historical aliases or comment identities. */
export function threadRouteChanges(path: string, current: string | undefined, changes: Record<string, Json>, languages: ContentLanguages): Record<string, Json> {
  const location = threadPath(path, languages);
  const canonical = canonicalNativeThreadRoute(location.id, location.lang, languages.defaultLanguage);
  if (changes.path && route(String(changes.path)) !== canonical) throw new StudioError(400, '动态文件 {path} 不允许自定义公开路径', { path });
  const metadata = current ? threadMetadata({ path, text: current }) : {};
  if (metadata.path !== undefined && metadata.path !== '' && (typeof metadata.path !== 'string' || route(metadata.path) !== canonical)) throw new StudioError(400, '动态文件 {path} 不允许自定义公开路径', { path });
  return { path: canonical.slice(1, -1) };
}

export function validateThread(file: Pick<FileSnapshot, 'path' | 'text'>, languages: ContentLanguages): void {
  const location = threadPath(file.path, languages);
  const metadata = threadMetadata(file);
  if (metadata.layout !== undefined && metadata.layout !== '' && metadata.layout !== 'thread') throw new StudioError(400, '动态文件 {path} 只能使用 thread 模板', { path: file.path });
  const canonical = canonicalNativeThreadRoute(location.id, location.lang, languages.defaultLanguage);
  if (typeof metadata.path !== 'string' || route(metadata.path) !== canonical) throw new StudioError(400, '动态文件 {path} 不允许自定义公开路径', { path: file.path });
  if (metadata.slug !== undefined && metadata.slug !== '' && metadata.slug !== location.id) throw new StudioError(400, '动态文件 {path} 的 slug 必须与目录 id 一致', { path: file.path });
  const value = (key: string) => String(getValue(metadata, `extra.${key}`) ?? '');
  if (value('kind') !== 'thread' || value('id') !== location.id) throw new StudioError(400, '动态需要有效的 kind 和 id，id 必须与目录一致');
  const date = String(metadata.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(date) || !Number.isFinite(Date.parse(date))) throw new StudioError(400, '动态发布时间必须包含完整时间和时区');
  const references = getValue(metadata, 'extra.references');
  if (!String(metadata.title || '').trim() && !splitDocument(file.text).body.trim() && !(Array.isArray(references) && references.length)) throw new StudioError(400, '请填写动态正文、标题或引用文章');
}
// Independent threads validate only the candidate, so another broken thread never blocks edits.
export function threadWriteGuard(path: string, text: string | null): WriteGuard {
  return async repository => {
    if (text === null) return;
    const config = await repository.read('config.toml');
    const languages = threadLanguages(config ? parse(config.text) : {});
    validateThread({ path, text }, languages);
    const location = threadPath(path, languages), canonical = canonicalNativeThreadRoute(location.id, location.lang, languages.defaultLanguage);
    for (const file of await repository.list()) {
      if (file.path === path || !/^content\/threads\/[^/]+\/index(?:\.[A-Za-z0-9-]+)?\.md$/.test(file.path)) continue;
      let sibling;
      try { sibling = threadPath(file.path, languages); } catch { continue; }
      if (canonicalNativeThreadRoute(sibling.id, sibling.lang, languages.defaultLanguage) === canonical) throw new StudioError(409, '动态公开路径已被其他内容使用');
    }
  };
}
