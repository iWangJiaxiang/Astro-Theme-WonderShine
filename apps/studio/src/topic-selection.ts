import type { ArticleSummary, ContentLanguages, Json } from '../shared/types';
import { newTopic, topicOptions } from './content-model';

export const topicName = (value: string): string => value.trim().replace(/\s+/gu, ' ');
export const topicNameKey = (value: string): string => topicName(value).normalize('NFKC').toLowerCase();

interface TopicGateway {
  list(): Promise<ArticleSummary[]>;
  languages(): Promise<ContentLanguages>;
  save(input: { path: string; changes: Record<string, Json>; body: string; revision: null }): Promise<unknown>;
}

// Refresh before creating so retrying a lost response can reuse the saved topic.
export async function createOrFindTopic(title: string, language: string, gateway: TopicGateway) {
  title = topicName(title);
  if (!title) throw new Error('请输入话题名称');
  if (title.length > 100) throw new Error('话题名称不能超过 100 个字符');
  const [items, languages] = await Promise.all([gateway.list(), gateway.languages()]);
  if (!languages.languages.includes(language)) throw new Error('话题语言未配置，请刷新后重试');
  const matches = items.filter(item => item.kind === 'topic' && item.id && !item.error && topicNameKey(item.title) === topicNameKey(title));
  const match = matches.find(item => item.lang === language) || matches[0];
  if (match) return { item: topicOptions(items.filter(item => item.id === match.id), language)[0], items, created: false };

  const draft = newTopic(language, languages.defaultLanguage);
  await gateway.save({ path: draft.path, changes: { ...draft.initial, title }, body: '', revision: null });
  const item: ArticleSummary = { path: draft.path, id: String(draft.initial['extra.id']), title, lang: language,
    kind: 'topic', draft: true, date: '', tags: [], categories: [], layout: 'topic' };
  return { item, items: [...items, item], created: true };
}
