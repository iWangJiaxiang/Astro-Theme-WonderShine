import type { Document, Site } from './types';
import { activeTimestamp, byDate, events, isPublic, notes, plain, taxonomyDocuments, taxonomySlug } from './queries';
import { localeConfig } from './content';

export const xml = (value: unknown) => String(value ?? '').replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[char]!));
export interface Feed { path: string; lang: string; kind: string; items: Document[]; titleSuffix?: string; sectionPath?: string; }

function filenames(site: Site, lang: string): string[] {
  return site.config.languages?.[lang]?.feed_filenames || site.config.feed_filenames || ['atom.xml'];
}
function articleFeedItems(site: Site, lang: string, supplied?: Document[]): Document[] {
  // Existing article feeds also contain dated collection chapters and music works.
  return (supplied || site.documents).filter(doc => doc.lang === lang && doc.date && !['note', 'topic'].includes(doc.kind) && isPublic(doc, site)).sort(byDate);
}

export function feeds(site: Site): Feed[] {
  const result = new Map<string, Feed>();
  const addScope = (prefix: string, lang: string, items: Document[], metadata: Pick<Feed, 'titleSuffix' | 'sectionPath'> = {}) => {
    for (const filename of filenames(site, lang)) {
      if (!['atom.xml', 'rss.xml', 'notes.xml', 'timeline.xml'].includes(filename)) throw new Error(`Unsupported feed layout: ${filename}`);
      const kind = filename.slice(0, -4);
      const pathname = `${prefix}${kind}`;
      if (result.has(pathname)) throw new Error(`Duplicate feed route: ${pathname}.xml`);
      // The legacy custom templates intentionally use the full locale activity set,
      // including when Zola invokes them at a taxonomy or section feed URL.
      const entries = kind === 'notes' ? notes(site, lang) : kind === 'timeline' ? events(site, lang) : articleFeedItems(site, lang, items);
      result.set(pathname, { path: pathname, lang, kind, items: entries, ...metadata });
    }
  };
  for (const lang of site.languages) {
    const language = site.config.languages?.[lang] || {};
    const prefix = lang === site.defaultLanguage ? '' : `${lang}/`;
    if ((language.generate_feeds ?? site.config.generate_feeds) === true) addScope(prefix, lang, site.documents);
    const taxonomies = lang === site.defaultLanguage ? site.config.taxonomies : language.taxonomies;
    for (const taxonomy of taxonomies || []) {
      if (!taxonomy.feed) continue;
      const docs = taxonomyDocuments(site, lang, taxonomy.name);
      for (const term of [...new Set(docs.flatMap(doc => doc.taxonomies[taxonomy.name]))].sort()) {
        addScope(`${prefix}${taxonomy.name}/${taxonomySlug(site, term)}/`, lang, docs.filter(doc => doc.taxonomies[taxonomy.name].includes(term)), { titleSuffix: term });
      }
    }
  }
  for (const section of site.sections) {
    if (!section.frontmatter.generate_feeds || section.draft || section.ancestors.some(source => site.sections.find(parent => parent.relativePath === source)?.draft)) continue;
    const localeRoot = section.lang === site.defaultLanguage ? '/' : `/${section.lang}/`;
    if (section.url === localeRoot && (site.config.languages?.[section.lang]?.generate_feeds ?? site.config.generate_feeds) === true) continue;
    // A section can explicitly generate feeds even when it has no HTML index.
    const docs = site.documents.filter(doc => doc.lang === section.lang && [...doc.ancestors].reverse().some((source, index, ancestors) =>
      source === section.relativePath && ancestors.slice(0, index).every(parent => site.sections.find(item => item.relativePath === parent)?.transparent)));
    addScope(section.url.slice(1), section.lang, docs, { titleSuffix: section.title, sectionPath: section.url });
  }
  return [...result.values()];
}

function contentSummary(doc: Document): string {
  return /<!--\s*more\s*-->/.test(doc.body) ? doc.html.split('<span id="continue-reading">')[0] : doc.description;
}
function isoDate(date?: string): string {
  const milliseconds = date ? Date.parse(date) : NaN;
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : '1970-01-01T00:00:00.000Z';
}
function author(doc: Document, config: Site['config']): string[] {
  return Array.isArray(doc.frontmatter.authors) && doc.frontmatter.authors.length ? doc.frontmatter.authors.map(String) : [String(config.author || 'Unknown')];
}

export function renderFeed(site: Site, feed: Feed): string {
  const config = localeConfig(site, feed.lang);
  const absolute = (pathname: string) => new URL(pathname, config.base_url).href;
  const eligible = feed.items.filter(doc => isPublic(doc, site));
  const limit = Number.isInteger(config.feed_limit) && config.feed_limit >= 0 ? config.feed_limit : eligible.length;
  const items = eligible.slice(0, limit);
  const custom = feed.kind === 'notes' || feed.kind === 'timeline';
  const title = `${config.title || ''}${custom ? feed.kind === 'notes' ? ' · Notes' : ' · Timeline' : feed.titleSuffix ? ` - ${feed.titleSuffix}` : ''}`;
  const link = absolute(feed.sectionPath || (feed.lang === site.defaultLanguage ? '/' : `/${feed.lang}/`));
  const self = absolute(`/${feed.path}.xml`);
  const updated = new Date(Math.max(0, ...items.map(doc => activeTimestamp(doc) * 1000))).toISOString();
  if (feed.kind === 'atom') {
    const follow = config.extra?.feed?.follow;
    return `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${xml(feed.lang)}"><title>${xml(title)}</title>${config.description ? `<subtitle>${xml(config.description)}</subtitle>` : ''}${config.extra?.site?.logo ? `<icon>${xml(absolute(config.extra.site.logo))}</icon>` : ''}<link href="${xml(self)}" rel="self" type="application/atom+xml"/><link href="${xml(link)}" rel="alternate" type="text/html"/><id>${xml(self)}</id><generator uri="https://astro.build/">Astro</generator><updated>${xml(updated)}</updated>${config.author ? `<author><name>${xml(config.author)}</name></author>` : ''}${follow?.feed_id ? `<follow_challenge><feedId>${xml(follow.feed_id)}</feedId><userId>${xml(follow.user_id)}</userId></follow_challenge>` : ''}${items.map(doc => `<entry><title>${xml(doc.title)}</title><link href="${xml(absolute(doc.url))}" rel="alternate" type="text/html"/><id>${xml(absolute(doc.url))}</id><published>${xml(isoDate(doc.date))}</published><updated>${xml(new Date(activeTimestamp(doc) * 1000).toISOString())}</updated>${author(doc, config).map(name => `<author><name>${xml(name)}</name></author>`).join('')}${contentSummary(doc) ? `<summary type="html">${xml(contentSummary(doc))}</summary>` : ''}${config.extra?.feed?.full_content_in_feed ? `<content type="html" xml:base="${xml(absolute(doc.url))}">${xml(doc.html)}</content>` : ''}</entry>`).join('')}</feed>`;
  }
  return `<?xml version="1.0" encoding="utf-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${xml(title)}</title><link>${xml(link)}</link><description>${xml(config.description)}</description><language>${xml(feed.lang)}</language><generator>Astro</generator><atom:link href="${xml(self)}" rel="self" type="application/rss+xml"/><lastBuildDate>${new Date(updated).toUTCString()}</lastBuildDate>${items.map(doc => `<item><title>${xml(doc.title || plain(doc.html).slice(0, 70))}</title><link>${xml(absolute(doc.url))}</link><guid isPermaLink="true">${xml(absolute(doc.url))}</guid><pubDate>${new Date(isoDate(doc.date)).toUTCString()}</pubDate>${!custom ? `<author>${xml(author(doc, config)[0])}</author>` : ''}<description xml:base="${xml(absolute(doc.url))}">${xml(custom ? doc.html : contentSummary(doc) || doc.html)}</description></item>`).join('')}</channel></rss>`;
}
