import type { ArticleSummary } from './types.js';

export const collectionRoot = 'content/collections/_index.md';
export const isSection = (item: ArticleSummary) => /\/_index(?:\.[A-Za-z0-9-]+)?\.md$/.test(item.path);
export const isLibraryItem = (item: ArticleSummary) => item.kind === 'collection' ? !/^content\/collections\/_index(?:\.[A-Za-z0-9-]+)?\.md$/.test(item.path) : !isSection(item);
export const sectionDirectory = (path: string) => path.replace(/_index(?:\.[A-Za-z0-9-]+)?\.md$/, '');

export function contentLabel(item: ArticleSummary): string {
  if (item.kind === 'collection') return !isSection(item) ? '章节' : item.render === false ? '目录分组' : item.layout === 'collection-list' ? '专栏' : '合集';
  return item.kind === 'article' ? '文章' : item.kind === 'thread' ? '动态' : '页面';
}

export function displayTitle(item: ArticleSummary): string {
  const fallbackTitle = item.path.split('/').slice(-2).join('/');
  if (item.title.trim() && item.title !== item.path && !(isSection(item) && item.title === fallbackTitle)) return item.title;
  if (item.path === collectionRoot) return '合集首页';
  const parts = item.path.split('/');
  return /^_?index(?:\.[A-Za-z0-9-]+)?\.md$/.test(parts.at(-1)!) ? parts.at(-2)! : parts.at(-1)!.replace(/\.md$/, '');
}

export function parentSection(item: ArticleSummary, items: ArticleSummary[]): string {
  return items.filter(candidate => candidate.kind === 'collection' && isSection(candidate) && candidate.path !== item.path && (!item.lang || !candidate.lang || candidate.lang === item.lang) && (isSection(item) ? sectionDirectory(item.path) !== sectionDirectory(candidate.path) : true) && item.path.startsWith(sectionDirectory(candidate.path)))
    .sort((a, b) => b.path.length - a.path.length)[0]?.path || items.find(candidate => candidate.kind === 'collection' && !isLibraryItem(candidate) && candidate.lang === item.lang)?.path || collectionRoot;
}

export function sectionTrail(path: string, items: ArticleSummary[]): ArticleSummary[] {
  const selected = items.find(item => item.path === path);
  return items.filter(item => item.kind === 'collection' && isSection(item) && isLibraryItem(item) && (!selected?.lang || !item.lang || item.lang === selected.lang) && (item.path === path || path.startsWith(sectionDirectory(item.path))))
    .sort((a, b) => a.path.length - b.path.length);
}

export function sortLibrary(items: ArticleSummary[], kind: ArticleSummary['kind']): ArticleSummary[] {
  return [...items].sort((a, b) => {
    if (kind === 'collection') return Number(isSection(b)) - Number(isSection(a)) || (a.weight || 0) - (b.weight || 0) || displayTitle(a).localeCompare(displayTitle(b), 'zh-CN', { numeric: true });
    if ((kind === 'article' || kind === 'thread') && a.date !== b.date) return (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0);
    return displayTitle(a).localeCompare(displayTitle(b), 'zh-CN', { numeric: true });
  });
}
