import type { Json } from './types.js';
import { translationLocation } from './translation.js';
import { canonicalNativeThreadRoute } from './thread-routes.js';
export { canonicalNativeThreadRoute } from './thread-routes.js';

function publicRoute(path: string) {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..') || /[?#\u0000-\u001f]/.test(path))
    return { linkWarning: '公开路径无效，请检查内容的路径设置' };
  return { publicPath: parts.length ? '/' + parts.join('/') + '/' : '/' };
}

// A front-matter path is absolute, including translated pages (legacy URL compatibility).
export function contentLink(file: string, metadata: Record<string, Json>, config: Record<string, Json>): { publicPath?: string; linkWarning?: string } {
  const defaultLanguage = String(config.default_language || 'en');
  const languages = [defaultLanguage, ...Object.keys(config.languages || {})];
  const localized = translationLocation(file, defaultLanguage, { defaultLanguage, languages });
  file = localized.translationKey;
  const prefix = localized.sourceLanguage === defaultLanguage ? '' : '/' + localized.sourceLanguage;
  const thread = file.match(/^content\/(threads|topics)\/([^/]+)\/index(?:\.([A-Za-z0-9-]+))?\.md$/);
  if (thread?.[1] === 'threads') return { publicPath: canonicalNativeThreadRoute(thread[2], localized.sourceLanguage, defaultLanguage) };
  const path = metadata.path;
  if (typeof path === 'string') return publicRoute(path);
  // Topics use ordinary content paths, including the configured slugify strategy.
  const slugify = config.slugify && typeof config.slugify === 'object' && !Array.isArray(config.slugify) ? config.slugify : {};
  const strategy = String(slugify.paths || 'on');
  const section = file.endsWith('/_index.md') || file === 'content/_index.md';
  const parts = file.replace(/^content\//, '').split('/');
  let stem = parts.pop()!.replace(/\.md$/, '');
  if (stem === 'index') stem = parts.pop() || '';
  else if (section) stem = '';
  if (!section && typeof metadata.slug === 'string') stem = metadata.slug;
  if (!section && !metadata.slug && slugify.paths_keep_dates !== true) stem = stem.replace(/^\d{4}-\d{2}-\d{2}[_-]/, '');
  const segments = section ? parts : [...parts, stem];
  const preserve = strategy === 'safe' || strategy === 'off';
  if (!preserve && segments.some(value => /[^\x00-\x7f]/.test(value))) return { linkWarning: '此路径需要转写，请填写构建后的地址' };
  const route = segments.map(value => preserve ? value.replace(/[<>:"|?*\u0000-\u001f]/g, '').trim()
    : value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')).join('/');
  return publicRoute(prefix + '/' + route);
}
