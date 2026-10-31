import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';
import {responsiveImage} from './image-assets';
import { full as emoji } from 'markdown-it-emoji';
import anyAscii from 'any-ascii';
import { split as unicodeWords } from 'unicode-default-word-boundary';
import Token from 'markdown-it/lib/token.mjs';
import type { DataRecord, Document, TocEntry } from './types';

export interface MarkdownContext {
  root?: string;
  document: Pick<Document, 'path' | 'relativePath' | 'lang'>;
  config: DataRecord;
  documentsBySource: Map<string, Pick<Document, 'path'>>;
  insertAnchorLinks?: string;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

/** Generate stable ASCII heading links. */
export function slugify(value: string): string {
  return anyAscii(value.replace(/\p{Script=Han}/gu, character => ` ${anyAscii(character)} `)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function decode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** Preserve root/external URLs and resolve content references before relative assets. */
export function resolveContentUrl(value: string, context: MarkdownContext): string {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|\/|#)/i.test(value)) return value;
  const decoded = decode(value);
  if (decoded.startsWith('@/')) {
    const [source, fragment] = decoded.slice(2).split('#');
    const document = context.documentsBySource.get(source.replace(/^content\//, ''));
    if (!document) throw new Error(`Unknown content reference ${value} in ${context.document.relativePath}`);
    return `${document.path}${fragment ? `#${fragment}` : ''}`;
  }
  return new URL(value, `https://content.invalid${context.document.path}`).pathname +
    new URL(value, `https://content.invalid${context.document.path}`).search +
    new URL(value, `https://content.invalid${context.document.path}`).hash;
}

function shortcodeArguments(source: string): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  const pattern = /([\w-]+)\s*=\s*("(?:\\.|[^"\\])*"|'[^']*'|true|false|-?\d+(?:\.\d+)?)(?:\s*,\s*|\s*$)/gy;
  let offset = 0;
  while (offset < source.length) {
    while (/\s/.test(source[offset] || '')) offset++;
    if (offset >= source.length) break;
    pattern.lastIndex = offset;
    const match = pattern.exec(source);
    if (!match) throw new Error(`Invalid shortcode arguments: ${source}`);
    const raw = match[2];
    result[match[1]] = raw.startsWith('"') ? JSON.parse(raw) : raw.startsWith("'") ? raw.slice(1, -1) : raw === 'true' ? true : raw === 'false' ? false : Number(raw);
    offset = pattern.lastIndex;
  }
  return result;
}

function subscriptionMarkup(context: MarkdownContext): string {
  const config = context.config.extra?.subscribe || {};
  const english = context.document.lang === 'en';
  const prefix = context.document.lang === (context.config.default_language || 'en') ? '' : `/${context.document.lang}`;
  const cards = [
    { type: 'wechat', href: config.wechat_url || `${prefix}/wechat/`, name: english ? 'WeChat subscription' : '公众号订阅', detail: english ? 'Selected articles<br>Full text' : '推送精选文章<br>推送全文', recommended: true, icon: 'wechat' },
    { type: 'mail', href: config.follow_url || '', name: english ? 'Follow subscription' : 'Follow 订阅', detail: english ? 'All articles<br>Covers and descriptions' : '推送全部文章<br>推送封面与简介', recommended: true, icon: 'mail' },
    { type: 'rss', href: config.rss_url || `${prefix}/rss.xml`, name: 'RSS', detail: english ? 'All articles<br>Descriptions' : '推送全部文章<br>推送简介', recommended: false, icon: 'rss' },
  ];
  return `<div class="rss-plan-list">${cards.filter(card => card.href).map(card => `<a class="rss-plan-item rss-plan-${card.type}" href="${escapeHtml(card.href)}" target="_blank" rel="noopener"><div class="rss-plan-description">${card.detail}</div><div class="rss-plan-info-group"><div class="rss-plan-title">${card.name}</div><div class="rss-plan-info">${english ? (card.recommended ? 'Recommended' : 'Alternative') : (card.recommended ? '推荐的订阅方式' : '备用订阅方式')}</div><img class="rss-plan-icon no-lightbox" src="/img/${card.icon}.svg" alt="${card.icon}" loading="lazy" decoding="async"></div></a>`).join('')}</div>`;
}

function shortcodeMarkup(name: string, args: Record<string, string | number | boolean>, context: MarkdownContext): string {
  if (name === 'subscribe_list') return subscriptionMarkup(context);
  if (name !== 'image') throw new Error(`Unsupported shortcode ${name} in ${context.document.relativePath}`);
  if (typeof args.img_name !== 'string' || !args.img_name) throw new Error('image shortcode requires img_name');
  const width = typeof args.width === 'number' && args.width > 0 ? args.width : 1000;
  const original = resolveContentUrl(args.img_name, context);
  const image = context.root ? responsiveImage({root:context.root,config:context.config},original,width) : undefined;
  const src = escapeHtml(original);
  const alt = escapeHtml(String(args.alt || ''));
  const dimensions = image?.width && image.height ? ` width="${width}" height="${Math.round(width * image.height / image.width)}"` : '';
  const sources=image?[['avif',image.avifSrcset],['webp',image.webpSrcset]].filter(([,set])=>set).map(([type,set])=>`<source type="image/${type}" srcset="${escapeHtml(set!)}" sizes="(max-width:900px) 100vw, ${width}px">`).join(''):'';
  return `<picture class="progressive-picture loaded" style="max-width:${width}px;height:auto;" alt="${alt}" src="${src}" data-original="${src}">${sources}<img class="progressive-content loaded no-lightbox" alt="${alt}"${dimensions} loading="lazy" decoding="async" src="${escapeHtml(image?.src||original)}" data-original="${src}"></picture>`;
}

function plainText(tokens: Token[]): string {
  return tokens.map(token => token.type === 'image' ? token.content : token.type === 'text' || token.type === 'code_inline' || token.type === 'emoji' ? token.content : token.children ? plainText(token.children) : '').join('');
}

/** Match Zola's raw-Markdown Unicode word count, excluding triple-backtick code. */
export function readingAnalytics(body: string): { wordCount: number; readingTime: number } {
  // Zola v0.20: components/content/src/utils.rs::get_reading_analytics.
  const wordCount = body.split('```').reduce((count, segment, index) => index % 2 ? count :
    count + unicodeWords(segment).filter(word => /[\p{Alphabetic}\p{Number}]/u.test(word)).length, 0);
  return { wordCount, readingTime: Math.ceil(wordCount / 200) };
}

export function renderMarkdown(body: string, context: MarkdownContext): { html: string; toc: TocEntry[]; wordCount: number; readingTime: number } {
  const settings = context.config.markdown || {};
  const md = new MarkdownIt({ html: true, linkify: false, typographer: Boolean(settings.smart_punctuation), breaks: false });
  // The plugin declaration targets the CommonJS MarkdownIt type; runtime API is identical.
  md.use(footnote as unknown as (markdown: MarkdownIt) => void);
  md.use(taskLists);
  if (settings.render_emoji) md.use(emoji as unknown as (markdown: MarkdownIt) => void);
  md.block.ruler.before('paragraph', 'site_shortcode_block', (state, startLine, _endLine, silent) => {
    const line = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]);
    const call = /^\{\{\s*([a-z_]\w*)\(([^]*?)\)\s*\}\}\s*$/i.exec(line);
    if (!call || !['image', 'subscribe_list'].includes(call[1])) return false;
    if (!silent) {
      const token = state.push('html_block', '', 0);
      token.content = shortcodeMarkup(call[1], shortcodeArguments(call[2]), context) + '\n';
      token.map = [startLine, startLine + 1];
      state.line = startLine + 1;
    }
    return true;
  });
  // Parse only recognized shortcode calls in normal text. Code spans/fences remain literal.
  md.inline.ruler.before('text', 'site_shortcode', (state, silent) => {
    if (state.src.slice(state.pos, state.pos + 2) !== '{{') return false;
    const call = /^\{\{\s*([a-z_]\w*)\(([^]*?)\)\s*\}\}/i.exec(state.src.slice(state.pos));
    if (!call || !['image', 'subscribe_list'].includes(call[1])) return false;
    if (!silent) {
      const token = state.push('html_inline', '', 0);
      token.content = shortcodeMarkup(call[1], shortcodeArguments(call[2]), context);
    }
    state.pos += call[0].length;
    return true;
  });
  const imageRule = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, index, options, env, renderer) => {
    const token = tokens[index];
    const original=resolveContentUrl(token.attrGet('src') || '', context);
    const image=context.root?responsiveImage({root:context.root,config:context.config},original):undefined;
    token.attrSet('src',image?.src||original);
    token.attrSet('data-original',original);
    if(image?.webpSrcset){token.attrSet('srcset',image.webpSrcset);token.attrSet('sizes','(max-width:900px) 100vw, 960px');}
    if (settings.lazy_async_image !== false) { token.attrSet('loading', 'lazy'); token.attrSet('decoding', 'async'); }
    return imageRule(tokens, index, options, env, renderer);
  };
  md.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
    const token = tokens[index];
    const href = resolveContentUrl(token.attrGet('href') || '', context);
    token.attrSet('href', href);
    const external = /^(https?:)?\/\//.test(href) && !href.startsWith(String(context.config.base_url || 'https://content.invalid'));
    if (external) {
      const rel: string[] = [];
      if (settings.external_links_target_blank) { token.attrSet('target', '_blank'); rel.push('noopener'); }
      if (settings.external_links_no_follow) rel.push('nofollow');
      if (settings.external_links_no_referrer) rel.push('noreferrer');
      if (rel.length) token.attrSet('rel', rel.join(' '));
    }
    return renderer.renderToken(tokens, index, options);
  };
  md.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index];
    const language = token.info.trim().split(/[ ,\t]+/)[0] || '';
    const attributes = language ? ` class="language-${escapeHtml(language)}" data-lang="${escapeHtml(language)}"` : '';
    return `<pre${attributes}><code${attributes}>${escapeHtml(token.content)}</code></pre>\n`;
  };
  const environment = {};
  const tokens = md.parse(body.replace(/<!--\s*more\s*-->/g, '<span id="continue-reading"></span>'), environment);
  const toc: TocEntry[] = [];
  const parents: TocEntry[] = [];
  const usedIds = new Set<string>();
  for (let index = 0; index < tokens.length; index++) {
    const heading = tokens[index];
    if (heading.type !== 'heading_open') continue;
    const inline = tokens[index + 1];
    const explicit = /\s*\{#([^\s}]+)(?:\s+[^}]*)?\}\s*$/.exec(inline.content);
    if (explicit) {
      inline.content = inline.content.slice(0, explicit.index);
      inline.children = md.parseInline(inline.content, {})[0].children;
    }
    const title = plainText(inline.children || []);
    let id = explicit?.[1] || slugify(title);
    const base = id;
    let suffix = 1;
    while (usedIds.has(id)) id = `${base}-${suffix++}`;
    usedIds.add(id);
    heading.attrSet('id', id);
    const entry: TocEntry = { id, title, level: Number(heading.tag.slice(1)), permalink: `${context.document.path}#${id}`, children: [] };
    while (parents.length && parents[parents.length - 1].level >= entry.level) parents.pop();
    if (parents.length) parents[parents.length - 1].children.push(entry); else toc.push(entry);
    parents.push(entry);
    if (context.insertAnchorLinks === 'heading') {
      const start = new Token('link_open', 'a', 1);
      start.attrs = [['class', 'heading-anchor'], ['href', `#${id}`], ['aria-label', `Anchor link for: ${id}`]];
      const end = new Token('link_close', 'a', -1);
      inline.children = [start, ...(inline.children || []), end];
    }
  }
  const aliases = context.config.headingAliases?.[context.document.path] || {};
  md.renderer.rules.heading_open = (headingTokens, index, options, _env, renderer) => {
    const current = headingTokens[index].attrGet('id') || '';
    const legacy = aliases[current];
    const alias = legacy && !usedIds.has(legacy)
      ? `<span id="${escapeHtml(legacy)}" class="legacy-anchor" aria-hidden="true" style="display:block;position:relative;top:-80px;height:0;overflow:hidden"></span>`
      : '';
    if (legacy) usedIds.add(legacy);
    // Keep aliases inside headings so they do not interrupt adjacent margin collapse.
    return renderer.renderToken(headingTokens, index, options) + alias;
  };
  const html = md.renderer.render(tokens, md.options, environment);
  return { html, toc, ...readingAnalytics(body) };
}
