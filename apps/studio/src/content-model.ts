import type { ArticleSummary, ContentLanguages, Json } from '../shared/types';
export type LocalizedKind = 'note' | 'topic';
export type { ContentLanguages };
export interface ContentDraft { path: string; initial: Record<string, Json>; initialBody?: string }
// Keep unclassifiable files reachable outside language and publication filters.
export function unclassifiedContentErrors(items: ArticleSummary[], kind: LocalizedKind): ArticleSummary[] {
  return items.filter(item => item.kind === kind && !!item.error && !item.lang);
}
export function contentId(kind: LocalizedKind): string { return kind === 'note' ? crypto.randomUUID() : `t_${crypto.randomUUID().replaceAll('-', '')}`; }
export function contentLanguage(path: string, defaultLanguage: string): string {
  return path.match(/\.([A-Za-z0-9-]+)\.md$/)?.[1] || defaultLanguage;
}
export function localizedPath(kind: LocalizedKind, id: string, language: string, defaultLanguage: string): string {
  return `content/${kind === 'note' ? 'notes' : 'topics'}/${id}/index${language === defaultLanguage ? '' : `.${language}`}.md`;
}
export function newNote(language: string, defaultLanguage: string, id = contentId('note'), date = new Date().toISOString()): ContentDraft {
  return { path: localizedPath('note', id, language, defaultLanguage), initial: { draft: true, date, 'extra.kind': 'note', 'extra.id': id } };
}
export function newTopic(language: string, defaultLanguage: string, id = contentId('topic')): ContentDraft {
  return { path: localizedPath('topic', id, language, defaultLanguage), initial: { draft: true, 'extra.kind': 'topic', 'extra.id': id, layout: 'topic' } };
}
export function translationDraft(source: ArticleSummary, language: string, defaultLanguage: string, metadata: Record<string, Json>, body: string): ContentDraft {
  const extra = metadata.extra as Record<string, Json> | undefined;
  const id = source.id || String(extra?.id || '');
  if (!id || !['note', 'topic'].includes(source.kind)) throw new Error('内容缺少稳定标识，请检查内容。');
  const kind = source.kind as LocalizedKind;
  return {
    path: localizedPath(kind, id, language, defaultLanguage), initialBody: body,
    initial: {
      title: metadata.title || '', description: metadata.description || '', date: source.date, draft: true,
      'extra.kind': kind, 'extra.id': id,
      ...(extra?.ai_translation === true || extra?.translation_source ? { 'extra.ai_translation': extra?.ai_translation === true, 'extra.translation_reviewed': false, 'extra.translation_source': source.path } : {}),
      ...(kind === 'topic' ? { layout: 'topic' } : {}),
      ...Object.fromEntries(['cover', 'disable_comment', ...(kind === 'note' ? ['topics'] : [])].filter(key => extra?.[key] !== undefined).map(key => [`extra.${key}`, extra![key]])),
      ...(kind === 'note' && metadata.taxonomies ? Object.fromEntries(Object.entries(metadata.taxonomies as Record<string, Json>).map(([key, value]) => [`taxonomies.${key}`, value])) : {}),
    },
  };
}
export function topicOptions(items: ArticleSummary[], language: string): ArticleSummary[] {
  const choices = new Map<string, ArticleSummary>();
  for (const item of items) {
    if (item.kind !== 'topic' || item.error || !item.id) continue;
    if (!choices.has(item.id) || item.lang === language) choices.set(item.id, item);
  }
  return [...choices.values()];
}
export function contentLabel(body: string, title?: Json): string {
  return String(title || body.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/[#*_>`~]/g, '').trim().split('\n')[0] || '').slice(0, 90);
}
