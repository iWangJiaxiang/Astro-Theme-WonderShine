import type { ArticleSummary, Json } from './types.js';

export interface Choice { value: string; label: string; searchTerms?: string[] }
export const stringValues = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];

export function taxonomyChoices(dictionary: Json | undefined, used: string[]): Choice[] {
  const options = new Map<string, string>();
  if (Array.isArray(dictionary)) for (const item of dictionary) {
    if (typeof item === 'string' && item) options.set(item, item);
    else if (item && typeof item === 'object' && !Array.isArray(item) && typeof item.id === 'string' && item.id) {
      options.set(item.id, typeof item.name === 'string' && item.name ? item.name : item.id);
    }
  }
  for (const value of used) if (!options.has(value)) options.set(value, value);
  return [...options].map(([value, label]) => ({ value, label }));
}

export function collectionChoices(items: ArticleSummary[], chaptersOnly = false, language?: string): Choice[] {
  const folder = (item: ArticleSummary) => item.path.replace(/^content\/collections\//, '').replace(/\/_index(?:\.[A-Za-z0-9-]+)?\.md$/, '');
  const byFolder = new Map<string, ArticleSummary>();
  for (const item of items.filter(item => item.kind === 'collection' && !item.error && /\/_index(?:\.[A-Za-z0-9-]+)?\.md$/.test(item.path) && !/^content\/collections\/_index(?:\.[A-Za-z0-9-]+)?\.md$/.test(item.path))) {
    const key = folder(item), previous = byFolder.get(key);
    if (!previous || item.lang === language || (!language && item.path.endsWith('/_index.md'))) byFolder.set(key, item);
  }
  const sections = [...byFolder.values()];
  const titles = new Map(sections.map(item => [folder(item), item.title]));
  return sections.filter(item => !chaptersOnly || (item.layout !== 'collection-list' && (item.layout === 'collection-detail' || folder(item).includes('/'))))
    .map(item => {
      const value = folder(item), parts = value.split('/');
      return { value, label: parts.map((part, index) => titles.get(parts.slice(0, index + 1).join('/')) || part).join(' / ') };
    });
}
