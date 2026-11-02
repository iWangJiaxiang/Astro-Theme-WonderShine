import type { Document, Site } from './types';
import { slugify } from './markdown';

export const plain = (html: string) => html.replace(/<[^>]+>/g, '').trim();
export const timestamp = (date?: string) => date ? Math.floor(new Date(date).getTime() / 1000) || 0 : 0;
export const byDate = (a: Document, b: Document) => timestamp(b.date) - timestamp(a.date) || a.url.localeCompare(b.url);

/** One public-content boundary for lists, feeds, references, and generated routes. */
export function isPublic(doc: Document, site: Site, now = Date.now()): boolean {
  if (doc.draft || doc.render === false) return false;
  if (['thread', 'topic'].includes(doc.kind) && !site.config.extra?.activity?.enable) return false;
  if (doc.date) {
    const date = Date.parse(doc.date);
    if (!Number.isFinite(date) || date > now) return false;
  }
  return !doc.ancestors.some(source => site.sections.find(section => section.relativePath === source)?.draft);
}

export function activeTimestamp(doc: Document, now = Date.now()): number {
  const published = timestamp(doc.date);
  const updated = timestamp(doc.updated);
  return updated > published && updated <= Math.floor(now / 1000) ? updated : published;
}

export const articles = (site: Site, lang: string) => site.documents.filter(d => d.lang === lang && d.kind === 'article' && isPublic(d, site)).sort(byDate);
export const threads = (site: Site, lang: string) => site.documents.filter(d => d.lang === lang && d.kind === 'thread' && isPublic(d, site)).sort((a,b) => activeTimestamp(b) - activeTimestamp(a) || byDate(a,b));
export const topics = (site: Site, lang: string) => site.documents.filter(d => d.lang === lang && d.kind === 'topic' && isPublic(d, site));
export const events = (site: Site, lang: string) => [...articles(site,lang), ...threads(site,lang)].sort(byDate);
export const topicItems = (site: Site, topic: Document) => isPublic(topic, site) && topic.extra.id ? events(site,topic.lang).filter(d => Array.isArray(d.extra.topics) && d.extra.topics.includes(topic.extra.id)) : [];

export function cover(doc: Document, site: Site, fallback = true): string {
  const value = doc.extra.cover || doc.extra.global_cover || (fallback ? site.config.extra?.site?.default_cover : '') || '';
  return /^(https?:|\/)/.test(value) ? value : value ? doc.url + value : '';
}
export function formatDate(date?: string, lang = 'zh-CN') {
  if (!date) return '';
  const value = new Date(date);
  if (!Number.isFinite(value.getTime())) return '';
  if (lang === 'zh-CN') return new Intl.DateTimeFormat('zh-CN', {year:'numeric',month:'2-digit',day:'2-digit', timeZone:'Asia/Shanghai'}).format(value).replace(/(\d+)\/(\d+)\/(\d+)/,'$1 年 $2 月 $3 日');
  return new Intl.DateTimeFormat(lang,{year:'numeric',month:'short',day:'numeric',timeZone:'Asia/Shanghai'}).format(value);
}
export function formatDateTime(date?: string, lang = 'zh-CN') {
  const day = formatDate(date, lang);
  if (!day) return '';
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZone: 'Asia/Shanghai',
  }).format(new Date(date!));
  return `${day} ${time} (UTC+08:00)`;
}

export function activitySummary(site: Site, lang: string) {
  const recent = threads(site, lang);
  return {
    articleCount: articles(site, lang).length,
    threadCount: recent.length,
    recent: recent.slice(0, 4),
    topics: topics(site, lang).map(topic => ({ topic, count: topicItems(site, topic).length })),
  };
}

export function taxonomyName(site: Site, kind: string, term: string, lang: string) {
  const data = site.localizedData?.[lang] || site.data;
  return data.post?.[kind]?.find((item:{id:string}) => item.id === term)?.name || term;
}
export function taxonomySlug(site: Site, term: string): string {
  const strategy = site.config.slugify?.taxonomies || 'on';
  return strategy === 'on' ? slugify(term) : term.replace(/[<>:"|?*\u0000-\u001f]/g, '').trim();
}
export function taxonomyDocuments(site: Site, lang: string, name: string): Document[] {
  return site.documents.filter(doc => doc.lang === lang && doc.taxonomies[name]?.length && isPublic(doc, site)).sort(byDate);
}
export function internalReference(site: Site, source: string, lang: string): Document | undefined {
  if (!source || source.includes('..') || source.includes('\\') || !/^(articles\/|collections\/(?!album\/))/.test(source) || !source.endsWith('.md')) return;
  const sourceLocale = site.languages.find(code => source.endsWith(`.${code}.md`));
  const canonical = sourceLocale ? `${source.slice(0, -(sourceLocale.length + 4))}.md` : source;
  if (/(?:^|\/)\_index\.md$/.test(canonical)) return;
  const languages = [...new Set([lang, site.defaultLanguage, ...site.languages])];
  for (const code of languages) {
    const candidatePath = code === site.defaultLanguage ? canonical : `${canonical.slice(0, -3)}.${code}.md`;
    const candidate = site.documents.find(doc => doc.relativePath === candidatePath && doc.lang === code && isPublic(doc, site));
    if (candidate) return candidate;
  }
}
export function descendants(site: Site, section: Document) {
  const prefix = section.relativePath.replace(/_index(?:\.[^/]+)?\.md$/, '');
  return site.documents.filter(d => d.lang === section.lang && d.relativePath.startsWith(prefix) && isPublic(d, site)).sort((a,b) => a.weight - b.weight || byDate(a,b));
}
