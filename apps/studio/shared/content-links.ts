import type { Json } from './types.js';
import { translationLocation } from './translation.js';
import { canonicalNativeNoteRoute } from './note-routes.js';
export { canonicalNativeNoteRoute } from './note-routes.js';

// A front-matter path is absolute, including translated pages (legacy URL compatibility).
export function contentLink(file: string, metadata: Record<string, Json>, config: Record<string, Json>): { publicPath?: string; linkWarning?: string } {
  const defaultLanguage = String(config.default_language || 'en');
  const languages = [defaultLanguage, ...Object.keys(config.languages || {})];
  const localized = translationLocation(file, defaultLanguage, { defaultLanguage, languages });
  file = localized.translationKey;
  const prefix = localized.sourceLanguage === defaultLanguage ? '' : '/' + localized.sourceLanguage;
  const note = file.match(/^content\/(notes|topics)\/([^/]+)\/index(?:\.([A-Za-z0-9-]+))?\.md$/);
  if (note?.[1] === 'notes') return { publicPath: canonicalNativeNoteRoute(note[2], localized.sourceLanguage, defaultLanguage) };
  const path = metadata.path;
  if (typeof path === 'string' && path) return { publicPath: '/' + path.replace(/^\/+|\/+$/g, '') + '/' };
  // Topics use ordinary content paths, including the configured slugify strategy.
  const slugify = config.slugify && typeof config.slugify === 'object' && !Array.isArray(config.slugify) ? config.slugify : {};
  const strategy = String(slugify.paths || 'on');
  const section = file.endsWith('/_index.md') || file === 'content/_index.md';
  const parts = file.replace(/^content\//, '').split('/');
  let stem = parts.pop()!.replace(/\.md$/, '');
  if (stem === 'index') stem = parts.pop() || '';
  else if (section) stem = '';
  if (!section && typeof metadata.slug === 'string' && metadata.slug) stem = metadata.slug;
  else if (!section && !slugify.paths_keep_dates) stem = stem.replace(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z)?[_-]/, '');
  const segments = [...parts, ...(stem ? stem.split('/') : [])];
  if (strategy === 'on' && segments.some(value => /[^\x00-\x7f]/.test(value))) return { linkWarning: '此路径需要转写，请填写构建后的地址' };
  const slug = (value: string) => strategy === 'safe' ? value.replace(/[<>:"/\\|?*]/g, '').replace(/\.+$/, '') : strategy === 'off' ? value : value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const route = segments.map(slug).filter(Boolean).join('/');
  return { publicPath: prefix + (route ? '/' + route + '/' : '/') };
}
