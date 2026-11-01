import { parse } from 'smol-toml';
import type { FileSnapshot, Json } from '../shared/types.js';
import type { WriteGuard } from '../shared/repository.js';
import { getValue, splitDocument, formDocumentMetadata } from './content.js';
import type { ContentLanguages } from '../shared/types.js';
import { StudioError } from './errors.js';
import { canonicalNativeNoteRoute, legacyNativeNoteRoute } from '../shared/note-routes.js';

export function noteLanguages(config: Record<string, unknown>): ContentLanguages {
  const defaultLanguage = typeof config.default_language === 'string' ? config.default_language : 'en';
  const configured = config.languages && typeof config.languages === 'object' ? Object.keys(config.languages) : [];
  return { defaultLanguage, languages: [...new Set([defaultLanguage, ...configured])] };
}
export function notePath(path: string, languages: ContentLanguages) {
  const match = path.match(/^content\/notes\/([a-zA-Z0-9][a-zA-Z0-9_-]*)\/index(?:\.([A-Za-z0-9-]+))?\.md$/);
  if (!match) throw new StudioError(400, '动态路径必须为 content/notes/<id>/index.md 或语言版本');
  const lang = match[2] || languages.defaultLanguage;
  if (!languages.languages.includes(lang) || match[2] === languages.defaultLanguage) throw new StudioError(400, '动态语言未配置，默认语言请使用 index.md');
  return { id: match[1], lang };
}


export function noteMetadata(file: Pick<FileSnapshot, 'path' | 'text'>): Record<string, unknown> {
  try { return formDocumentMetadata(splitDocument(file.text).header); }
  catch { throw new StudioError(400, '动态文件 {path} 的 TOML 格式需要检查', { path: file.path }); }
}

const route = (path: string) => '/' + path.replace(/^\/+|\/+$/g, '') + '/';

/** System-maintained content routing; existing files migrate without moving bundles. */
export function noteRouteChanges(path: string, current: string | undefined, changes: Record<string, Json>, languages: ContentLanguages): Record<string, Json> {
  const location = notePath(path, languages);
  const canonical = canonicalNativeNoteRoute(location.id, location.lang, languages.defaultLanguage);
  const legacy = legacyNativeNoteRoute(location.id, location.lang, languages.defaultLanguage);
  if (changes.path && route(String(changes.path)) !== canonical) throw new StudioError(400, '动态文件 {path} 不允许自定义公开路径', { path });
  const metadata = current ? noteMetadata({ path, text: current }) : {};
  if (metadata.path !== undefined && typeof metadata.path !== 'string') throw new StudioError(400, '动态文件 {path} 不允许自定义公开路径', { path });
  const previous = typeof metadata.path === 'string' && metadata.path ? route(metadata.path) : legacy;
  if (previous !== canonical && previous !== legacy) throw new StudioError(400, '动态文件 {path} 不允许自定义公开路径', { path });
  const result: Record<string, Json> = { path: canonical.slice(1, -1) };
  if (current && previous === legacy) {
    const aliases = metadata.aliases;
    if (aliases !== undefined && (!Array.isArray(aliases) || aliases.some(alias => typeof alias !== 'string'))) throw new StudioError(400, '动态旧地址列表格式不正确');
    const preserved = [...new Set((aliases as string[] | undefined || []).filter(alias => route(alias) !== canonical))];
    result.aliases = preserved.some(alias => route(alias) === legacy) ? preserved : [...preserved, legacy];
    // Existing translations already share the locale-neutral legacy comment identity.
    result['extra.comment_path'] = String(getValue(metadata, 'extra.comment_path') || `/notes/${location.id}/`);
  }
  return result;
}

export function validateNote(file: Pick<FileSnapshot, 'path' | 'text'>, languages: ContentLanguages): void {
  const location = notePath(file.path, languages);
  const metadata = noteMetadata(file);
  if (metadata.layout !== undefined && metadata.layout !== '' && metadata.layout !== 'note') throw new StudioError(400, '动态文件 {path} 只能使用 note 模板', { path: file.path });
  const canonical = canonicalNativeNoteRoute(location.id, location.lang, languages.defaultLanguage);
  if (typeof metadata.path !== 'string' || route(metadata.path) !== canonical) throw new StudioError(400, '动态文件 {path} 不允许自定义公开路径', { path: file.path });
  if (metadata.slug !== undefined && metadata.slug !== '' && metadata.slug !== location.id) throw new StudioError(400, '动态文件 {path} 的 slug 必须与目录 id 一致', { path: file.path });
  const value = (key: string) => String(getValue(metadata, `extra.${key}`) ?? '');
  if (value('kind') !== 'note' || value('id') !== location.id) throw new StudioError(400, '动态需要有效的 kind 和 id，id 必须与目录一致');
  const date = String(metadata.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(date) || !Number.isFinite(Date.parse(date))) throw new StudioError(400, '动态发布时间必须包含完整时间和时区');
  const references = getValue(metadata, 'extra.references');
  if (!String(metadata.title || '').trim() && !splitDocument(file.text).body.trim() && !(Array.isArray(references) && references.length)) throw new StudioError(400, '请填写动态正文、标题或引用文章');
}
// Independent notes validate only the candidate, so another broken note never blocks edits.
export function noteWriteGuard(path: string, text: string | null): WriteGuard {
  return async repository => {
    if (text === null) return;
    const config = await repository.read('config.toml');
    const languages = noteLanguages(config ? parse(config.text) : {});
    validateNote({ path, text }, languages);
    const location = notePath(path, languages), canonical = canonicalNativeNoteRoute(location.id, location.lang, languages.defaultLanguage);
    for (const file of await repository.list()) {
      if (file.path === path || !/^content\/notes\/[^/]+\/index(?:\.[A-Za-z0-9-]+)?\.md$/.test(file.path)) continue;
      let sibling;
      try { sibling = notePath(file.path, languages); } catch { continue; }
      if (canonicalNativeNoteRoute(sibling.id, sibling.lang, languages.defaultLanguage) === canonical) throw new StudioError(409, '动态公开路径已被其他内容使用');
    }
  };
}
