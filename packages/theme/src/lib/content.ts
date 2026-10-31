import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { themePath } from './theme-paths';
import { parse } from 'smol-toml';
import { renderMarkdown, slugify } from './markdown';
import type { ContentAsset, DataRecord, Document, Site } from './types';

export interface LoadSiteOptions { root?: string; includeDrafts?: boolean; }

export function parseFrontmatter(source: string, filename = 'document'): { data: DataRecord; body: string } {
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = /^\+\+\+\s*\n([^]*?)\n\+\+\+(?:\n|$)/.exec(normalized);
  if (!match) throw new Error(`Expected TOML frontmatter in ${filename}`);
  try { return { data: parse(match[1]), body: normalized.slice(match[0].length) }; }
  catch (error) { throw new Error(`Invalid TOML frontmatter in ${filename}: ${error instanceof Error ? error.message : error}`); }
}

async function readToml(filename: string, optional = false): Promise<DataRecord> {
  try { return parse(await readFile(filename, 'utf8')); }
  catch (error) { if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.filter(entry => !entry.name.startsWith('.')).map(async entry => {
    const filename = path.join(directory, entry.name);
    // Do not read content or assets outside the source tree via symlinks.
    return entry.isDirectory() ? walk(filename) : entry.isFile() ? [filename] : [];
  }));
  return files.flat().sort();
}

export function mergeData(base: DataRecord, override: DataRecord): DataRecord {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) &&
      result[key] && typeof result[key] === 'object' && !Array.isArray(result[key]) ? mergeData(result[key], value) : value;
  }
  return result;
}

export function localeConfig(site: Site, lang: string): DataRecord {
  const overrides = site.config.languages?.[lang] || {};
  return mergeData(mergeData(site.config, overrides), { extra: site.config.extra?.locale?.[lang] || {} });
}

function canonicalPath(value: string): string {
  const parts = value.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..')) throw new Error(`Unsafe public content path: ${value}`);
  if (/[?#\u0000-\u001f]/.test(value)) throw new Error(`Invalid public content path: ${value}`);
  return parts.length ? `/${parts.join('/')}/` : '/';
}

function dateValue(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' && value ? value : undefined;
}

function filenameInfo(relativePath: string, languages: string[], defaultLanguage: string): { stem: string; lang: string; group: string } {
  const stem = relativePath.replace(/\.md$/i, '');
  const language = languages.find(lang => stem.endsWith(`.${lang}`));
  return { stem: language ? stem.slice(0, -language.length - 1) : stem, lang: language || defaultLanguage,
    group: `${language ? stem.slice(0, -language.length - 1) : stem}.md` };
}

function pathSegment(value: string, config: DataRecord): string {
  if (config.slugify?.paths === 'safe' || config.slugify?.paths === 'off') {
    return value.replace(/[<>:"|?*\u0000-\u001f]/g, '').trim();
  }
  return slugify(value);
}

function legacyLayout(value: unknown): string | undefined {
  return typeof value === 'string' ? value.replace(/^page\//, '').replace(/\.html$/, '') : undefined;
}
/** Read site-owned content; layouts are rendered by Astro. */
export async function loadSite(options: LoadSiteOptions = {}): Promise<Site> {
  const root = path.resolve(options.root || process.env.ASTRO_SITE_ROOT || process.cwd());
  const userConfig = await readToml(path.join(root, 'config.toml'));
  const theme = await readToml(themePath('defaults/config.toml'));
  const config = mergeData({ extra: theme.extra || {} }, userConfig);
  // Theme demo SEO text is not a site's authored description.
  config.extra.site = { ...config.extra.site, seo: userConfig.extra?.site?.seo ?? '' };
  if (process.env.ASTRO_SITE_URL) config.base_url = new URL(process.env.ASTRO_SITE_URL).href.replace(/\/$/, '');
  const defaultLanguage = String(config.default_language || 'en');
  const languages = [defaultLanguage, ...Object.keys(config.languages || {}).filter(lang => lang !== defaultLanguage)];
  const aliasesFile = path.join(root, 'compatibility/heading-aliases.json');
  try { config.headingAliases = JSON.parse(await readFile(aliasesFile, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const data = await readToml(path.join(root, 'data.toml'), true);
  const localizedData: Record<string, DataRecord> = {};
  for (const lang of languages) localizedData[lang] = lang === defaultLanguage ? data : mergeData(data, await readToml(path.join(root, `data.${lang}.toml`), true));
  const contentRoot = path.join(root, 'content');
  const files = await walk(contentRoot);
  const markdownFiles = files.filter(filename => filename.endsWith('.md'));
  const all: Document[] = await Promise.all(markdownFiles.map(async filename => {
    const relativePath = path.relative(contentRoot, filename).split(path.sep).join('/');
    const { data: frontmatter, body } = parseFrontmatter(await readFile(filename, 'utf8'), relativePath);
    const info = filenameInfo(relativePath, languages, defaultLanguage);
    const basename = path.posix.basename(info.stem);
    const isSection = basename === '_index';
    const isBundle = basename === 'index';
    const directory = path.posix.dirname(info.stem);
    let slug = typeof frontmatter.slug === 'string' ? frontmatter.slug : isSection || isBundle ? path.posix.basename(directory) : basename;
    if (slug === '.') slug = '';
    if (config.slugify?.paths_keep_dates !== true && !frontmatter.slug) slug = slug.replace(/^\d{4}-\d{2}-\d{2}[-_]/, '');
    slug = pathSegment(slug, config);
    let publicPath: string;
    if (typeof frontmatter.path === 'string') publicPath = canonicalPath(frontmatter.path);
    else {
      const parentDirectory = isBundle ? path.posix.dirname(directory) : directory;
      const segments = isSection ? directory === '.' ? [] : directory.split('/') : [...(parentDirectory === '.' ? [] : parentDirectory.split('/')), slug];
      const normalizedSegments = segments.map(segment => pathSegment(segment, config));
      if (info.lang !== defaultLanguage) normalizedSegments.unshift(info.lang);
      publicPath = canonicalPath(normalizedSegments.join('/'));
    }
    const kind = isSection ? 'section' : relativePath.startsWith('articles/') ? 'article' : frontmatter.extra?.kind === 'note' || relativePath.startsWith('notes/') ? 'note' : relativePath.startsWith('topics/') ? 'topic' : 'page';
    const taxonomies: Record<string, string[]> = {};
    for (const [name, values] of Object.entries(frontmatter.taxonomies || {})) taxonomies[name] = Array.isArray(values) ? values.map(String) : [];
    return {
      id: String(frontmatter.extra?.id || info.group), relativePath, path: publicPath, url: publicPath,
      lang: info.lang, title: String(frontmatter.title || ''), description: String(frontmatter.description || '').trim(),
      date: dateValue(frontmatter.date), updated: dateValue(frontmatter.updated), draft: Boolean(frontmatter.draft),
      extra: frontmatter.extra || {}, taxonomies, body, html: '', toc: [], aliases: (frontmatter.aliases || []).map((alias: string) => {
        // Aliases containing a file extension (e.g. legacy .html URLs) remain file routes.
        const normalized = canonicalPath(String(alias));
        return /\.[a-z0-9]+\/$/i.test(normalized) ? normalized.slice(0, -1) : normalized;
      }), translations: [], kind, layout: frontmatter.layout || legacyLayout(frontmatter.template), slug, weight: Number(frontmatter.weight) || 0,
      render: frontmatter.render !== false, transparent: Boolean(frontmatter.transparent), paginateBy: Number(frontmatter.paginate_by) || 0,
      childLayout: frontmatter.child_layout || legacyLayout(frontmatter.page_template), parent: undefined, ancestors: [], frontmatter, assets: [], wordCount: 0, readingTime: 0,
    } satisfies Document;
  }));
  const sections = all.filter(doc => doc.kind === 'section');
  const bySource = new Map(all.map(doc => [doc.relativePath, doc]));
  const byGroup = new Map<string, Document[]>();
  for (const doc of all) {
    const group = filenameInfo(doc.relativePath, languages, defaultLanguage).group;
    byGroup.set(group, [...(byGroup.get(group) || []), doc]);
    let directory = path.posix.dirname(doc.relativePath);
    if (doc.kind === 'section') directory = path.posix.dirname(directory);
    while (true) {
      const prefix = directory === '.' ? '' : `${directory}/`;
      const section = bySource.get(`${prefix}_index${doc.lang === defaultLanguage ? '' : `.${doc.lang}`}.md`) ||
        bySource.get(`${prefix}_index.md`);
      if (section && section !== doc) {
        if (!doc.parent) doc.parent = section.relativePath;
        doc.ancestors.unshift(section.relativePath);
        if (!doc.layout && section.childLayout) doc.layout = section.childLayout;
        if (section.draft) doc.draft = true;
      }
      if (directory === '.') break;
      directory = path.posix.dirname(directory);
    }
  }
  for (const group of byGroup.values()) for (const doc of group) doc.translations = group.filter(other => other !== doc && (options.includeDrafts || !other.draft));
  const assetFiles = files.filter(filename => !filename.endsWith('.md'));
  const allAssets = new Map<string, ContentAsset>();
  for (const filename of assetFiles) {
    const relative = path.relative(contentRoot, filename).split(path.sep).join('/');
    let directory = path.posix.dirname(relative);
    let owners: Document[] = [];
    while (!owners.length) {
      owners = all.filter(doc => path.posix.dirname(doc.relativePath) === directory && /(?:^|\/)(?:_?index)(?:\.[^/.]+)?\.md$/.test(doc.relativePath));
      if (directory === '.') break;
      if (!owners.length) directory = path.posix.dirname(directory);
    }
    for (const owner of owners) {
      if (owner.draft && !options.includeDrafts) continue;
      const suffix = path.posix.relative(directory, relative);
      const asset = { source: filename, path: `${owner.path}${suffix}` };
      owner.assets.push(asset);
      const existing = allAssets.get(asset.path);
      if (existing && existing.source !== asset.source) throw new Error(`Content asset collision at ${asset.path}`);
      allAssets.set(asset.path, asset);
    }
  }
  const visible = all.filter(doc => options.includeDrafts || !doc.draft);
  const paths = new Map<string, string>();
  for (const doc of visible) {
    if (doc.render) {
      for (const pathname of [doc.path, ...doc.aliases]) {
        const existing = paths.get(pathname);
        if (existing && existing !== doc.relativePath) throw new Error(`Content route collision at ${pathname}: ${existing} and ${doc.relativePath}`);
        paths.set(pathname, doc.relativePath);
      }
    }
    const anchorLinks = doc.frontmatter.insert_anchor_links || [...doc.ancestors].reverse().map(source => bySource.get(source)?.frontmatter.insert_anchor_links).find(Boolean) || 'none';
    const rendered = renderMarkdown(doc.body, { root, document: doc, config, documentsBySource: bySource, insertAnchorLinks: anchorLinks });
    Object.assign(doc, rendered);
  }
  return { root, config, data, localizedData, documents: visible.filter(doc => doc.kind !== 'section'), sections,
    languages, defaultLanguage, assets: [...allAssets.values()] };
}
