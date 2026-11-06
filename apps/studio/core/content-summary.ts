import { parse } from 'smol-toml';
import type { ArticleReference, ArticleSummary, ContentLanguages, Json } from '../shared/types.js';
import { stringValues } from '../shared/choices.js';
import { contentLink } from '../shared/content-links.js';
import { translationLocation } from '../shared/translation.js';
import { getValue } from './content.js';
import { threadLanguages, threadPath } from './threads.js';
import { topicPath } from './topics.js';

/** Config-independent facts only: no source document, arbitrary metadata, or revision. */
export interface ContentSummaryFacts {
  path: string;
  kind: ArticleSummary['kind'];
  fields?: {
    title: string | undefined; threadTitle: string; date: string; updated: string; id: string;
    references: ArticleReference[]; topics: string[]; draft: boolean;
    tags: string[]; categories: string[]; displayTags: string[]; layout?: string;
    link: { path?: string; slug?: string };
    description: string; render: boolean; weight: number;
  };
}

export interface ContentSummaryContext {
  config: Record<string, Json>;
  languages: ContentLanguages;
}

/** The caller owns config invalidation; creating a new context never reads documents. */
export function createContentSummaryContext(config: Record<string, Json> = {}): ContentSummaryContext {
  return { config, languages: threadLanguages(config) };
}

/**
 * Same candidate-delimiter validation as splitDocument, retaining the successful parse.
 * Never split on the first +++ alone: it can be inside a TOML multiline string.
 * Keep this scanner in parity with splitDocument (covered by summary tests).
 */
function parsedDocument(source: string) {
  const opening = /^\uFEFF?\+\+\+[ \t]*\r?\n/.exec(source);
  if (!opening) throw new Error('文章需要使用 +++ 包裹 TOML 元数据');
  const delimiters = /^\+\+\+[ \t]*(?:\r?\n|$)/gm;
  delimiters.lastIndex = opening[0].length;
  for (let match = delimiters.exec(source); match; match = delimiters.exec(source)) {
    const header = source.slice(opening[0].length, match.index);
    let metadata: ReturnType<typeof parse>;
    try { metadata = parse(header); } catch { continue; }
    return { metadata, body: source.slice(delimiters.lastIndex) };
  }
  throw new Error('文章 TOML 元数据格式不正确');
}

const date = (value: unknown) => value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : '';

/**
 * Deliberate normalization of the legacy unchecked cast: malformed reference lists
 * become empty, and only ArticleReference scalar fields may enter retained facts.
 * Reject unknown keys rather than retaining arbitrary nested metadata. This is a
 * structural boundary; repository/language-dependent validation remains on save.
 */
function summaryReferences(value: unknown): ArticleReference[] {
  if (!Array.isArray(value) || value.length > 12) return [];
  const references: ArticleReference[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    if (item.kind === 'internal' && typeof item.path === 'string'
      && Object.keys(item).every(key => key === 'kind' || key === 'path')) {
      references.push({ kind: 'internal', path: item.path });
    } else if (item.kind === 'external' && typeof item.url === 'string' && typeof item.title === 'string'
      && Object.keys(item).every(key => key === 'kind' || key === 'url' || key === 'title')) {
      references.push({ kind: 'external', url: item.url, title: item.title });
    } else return [];
  }
  return references;
}

/** Parse exactly one changed document. Missing fields represent a visible repair row. */
export function readContentSummaryFacts(file: { path: string; text: string }): ContentSummaryFacts {
  const path = file.path;
  const kind = path.startsWith('content/articles/') ? 'article' : path.startsWith('content/pages/') ? 'page' : path.startsWith('content/threads/') ? 'thread' : path.startsWith('content/topics/') ? 'topic' : 'collection';
  try {
    const { metadata, body } = parsedDocument(file.text);
    // Legacy link inputs were JSON-normalized (including TOML dates) before resolution.
    const link = JSON.parse(JSON.stringify({ path: metadata.path, slug: metadata.slug })) as Record<string, Json>;
    return { path, kind, fields: {
      title: metadata.title ? String(metadata.title) : undefined,
      threadTitle: kind === 'thread' && !metadata.title && !/\/_index(?:\.[^.]+)?\.md$/.test(path) ? body.replace(/[#*`>\[\]]/g, '').trim().slice(0, 80) : '',
      date: date(metadata.date), updated: date(metadata.updated),
      id: (kind === 'thread' || kind === 'topic') && !/\/_index(?:\.[^.]+)?\.md$/.test(path) ? String(getValue(metadata, 'extra.id') || '') : '',
      references: summaryReferences(getValue(metadata, 'extra.references')),
      topics: stringValues(getValue(metadata, 'extra.topics')), draft: metadata.draft === true,
      tags: stringValues(getValue(metadata, 'taxonomies.tags')), categories: stringValues(getValue(metadata, 'taxonomies.categories')),
      displayTags: stringValues(getValue(metadata, 'extra.tags')), layout: typeof metadata.layout === 'string' ? metadata.layout : undefined,
      link: { ...(typeof link.path === 'string' ? { path: link.path } : {}), ...(typeof link.slug === 'string' ? { slug: link.slug } : {}) },
      description: typeof metadata.description === 'string' ? metadata.description : '', render: metadata.render !== false,
      weight: typeof metadata.weight === 'number' ? metadata.weight : 0,
    } };
  } catch {
    return { path, kind };
  }
}

/**
 * Path updates preserve existing order/duplicates; null deletes. New paths append
 * in change order only: this does NOT reproduce repository enumeration order.
 * An index must invalidate/refetch on unseen paths unless its repository supplies
 * an ordering capability. Do not infer native recursive/group order via global sort.
 */
export function updateContentSummaryFacts(current: readonly ContentSummaryFacts[], changes: ReadonlyMap<string, ContentSummaryFacts | null>): ContentSummaryFacts[] {
  for (const [path, facts] of changes) if (facts && facts.path !== path) throw new Error('Summary fact path mismatch');
  const remaining = new Map(changes);
  const next: ContentSummaryFacts[] = [];
  for (const facts of current) {
    const replacement = changes.has(facts.path) ? changes.get(facts.path) : facts;
    if (replacement) next.push(replacement);
    remaining.delete(facts.path);
  }
  for (const facts of remaining.values()) if (facts) next.push(facts);
  return next;
}

/** Projection is repeatable; config/path errors are repair rows, not dropped documents. */
export function projectContentSummary(facts: ContentSummaryFacts, context: ContentSummaryContext): ArticleSummary {
  const { path, kind, fields } = facts;
  const { config, languages } = context;
  try {
    if (!fields) throw new Error('Invalid document');
    const localized = (kind === 'thread' || kind === 'topic') && !/\/_index(?:\.[^.]+)?\.md$/.test(path) ? (kind === 'topic' ? topicPath : threadPath)(path, languages) : undefined;
    const locale = translationLocation(path, languages.defaultLanguage, languages);
    return { path, title: fields.title ?? ((kind === 'thread' && localized ? fields.threadTitle : '') || path.split('/').slice(-2).join('/')), date: fields.date,
      lang: locale.sourceLanguage, translationKey: locale.translationKey,
      ...(localized ? { id: fields.id } : {}), references: summaryReferences(fields.references),
      updated: fields.updated, topics: [...fields.topics], draft: fields.draft, kind,
      tags: [...fields.tags], categories: [...fields.categories], displayTags: [...fields.displayTags], layout: fields.layout,
      ...contentLink(path, fields.link, config), description: fields.description, render: fields.render, weight: fields.weight };
  } catch {
    let lang: string | undefined;
    try { lang = kind === 'thread' || kind === 'topic' ? (kind === 'topic' ? topicPath : threadPath)(path, languages).lang : translationLocation(path, languages.defaultLanguage, languages).sourceLanguage; } catch { /* Unknown or malformed paths remain visible for repair. */ }
    return { path, title: path, date: '', draft: false, kind, tags: [], categories: [], lang, error: 'TOML 格式需要检查' };
  }
}

/**
 * Pure cooperative projection. Each step matches a legacy list work unit (document,
 * sorted language group, final row). Feed facts lazily to include parsing in slices.
 * The caller supplies scheduling; this module performs no I/O or timer work.
 */
export function* contentSummarySteps(facts: Iterable<ContentSummaryFacts>, context: ContentSummaryContext): Generator<void, ArticleSummary[]> {
  const summaries: ArticleSummary[] = [];
  const languageGroups = new Map<string, string[]>();
  for (const fact of facts) {
    const item = projectContentSummary(fact, context);
    summaries.push(item);
    if (item.translationKey && item.lang) {
      let group = languageGroups.get(item.translationKey);
      if (!group) languageGroups.set(item.translationKey, group = []);
      group.push(item.lang);
    }
    yield;
  }
  for (const group of languageGroups.values()) {
    group.sort();
    yield;
  }
  for (const item of summaries) {
    // Keep independent arrays and duplicate languages, as in the previous API.
    item.availableLanguages = item.translationKey ? [...(languageGroups.get(item.translationKey) ?? [])] : [];
    yield;
  }
  return summaries;
}

/** Rebuild links and language siblings from retained facts, with no TOML parsing. */
export function projectContentSummaries(facts: Iterable<ContentSummaryFacts>, context: ContentSummaryContext): ArticleSummary[] {
  const steps = contentSummarySteps(facts, context);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}
