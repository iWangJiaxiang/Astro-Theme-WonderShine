import type { ArticleSummary, Json } from '../shared/types.js';

export function metadataValue(metadata: Record<string, Json>, path: string): Json | undefined {
  let current: Json | undefined = metadata;
  for (const part of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = current[part];
  }
  return current;
}

export function publicContentUrl(path: string | undefined, base: string | undefined): string | undefined {
  if (!path || !base || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return undefined;
  try {
    const site = new URL(base), url = new URL(path, site);
    if (!['https:', 'http:'].includes(site.protocol) || site.username || site.password || url.origin !== site.origin) return undefined;
    return url.href;
  } catch { return undefined; }
}

export function isPublishedContent(item: ArticleSummary | undefined, now = Date.now()): boolean {
  if (!item || item.draft || item.error || item.render === false) return false;
  if (!item.date && (item.kind === 'page' || item.kind === 'collection')) return true;
  const date = Date.parse(item.date);
  return !Number.isNaN(date) && date <= now;
}

export function previewLink(href: string, items: ArticleSummary[], currentPath: string | undefined, siteUrl: string | undefined): string | undefined {
  if (href.startsWith('#')) return href;
  if (href.startsWith('@/')) {
    const hash = href.indexOf('#');
    let sourcePath: string;
    try { sourcePath = decodeURIComponent(href.slice(2, hash < 0 ? undefined : hash)); } catch { return undefined; }
    const target = items.find(item => item.path.replace(/^content\//, '') === sourcePath);
    if (!isPublishedContent(target)) return undefined;
    const url = publicContentUrl(target?.publicPath, siteUrl);
    return url ? url + (hash < 0 ? '' : href.slice(hash)) : undefined;
  }
  try {
    const target = new URL(href, publicContentUrl(currentPath, siteUrl));
    if (!['http:', 'https:', 'mailto:'].includes(target.protocol) || target.username || target.password) return undefined;
    return target.href;
  } catch { return undefined; }
}

export interface DetailReference {
  kind: 'internal' | 'external'; title: string; href?: string; path?: string;
  language?: string; draft?: boolean; missing?: boolean;
}

export function threadReferences(value: Json | undefined, items: ArticleSummary[], language: string, defaultLanguage: string): DetailReference[] {
  if (!Array.isArray(value)) return [];
  const result: DetailReference[] = [];
  for (const reference of value) {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)) continue;
    if (reference.kind === 'internal' && typeof reference.path === 'string') {
      const versions = items.filter(item => !item.error && (item.translationKey || item.path).replace(/^content\//, '') === reference.path);
      const target = versions.find(item => item.lang === language) || versions.find(item => item.lang === defaultLanguage) || versions[0];
      result.push({ kind: 'internal', title: target?.title || reference.path, path: target?.path, language: target?.lang, draft: target?.draft, missing: !target });
    } else if (reference.kind === 'external' && typeof reference.url === 'string') {
      let href: string | undefined;
      try {
        const url = new URL(reference.url);
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) href = url.href;
      } catch { /* Invalid imported URLs remain visible without a clickable link. */ }
      result.push({ kind: 'external', title: String(reference.title || reference.url), href });
    }
  }
  return result;
}
