import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadSite, localeConfig, parseFrontmatter } from '../src/lib/content';
import { readingAnalytics, renderMarkdown, resolveContentUrl, slugify } from '../src/lib/markdown';

const repository = path.resolve(import.meta.dirname, '../../../examples/demo');
const config = { base_url: 'https://example.com', markdown: { render_emoji: true, external_links_target_blank: true, external_links_no_follow: true } };
const context = { config, document: { path: '/articles/example/', relativePath: 'articles/example/index.md', lang: 'zh-CN' }, documentsBySource: new Map([['articles/other/index.md', { path: '/articles/other/' }]]), insertAnchorLinks: 'heading' };

test('TOML frontmatter preserves typed metadata, dates, body and useful diagnostics', () => {
  const parsed = parseFrontmatter('+++\r\ntitle = "Example"\r\ndate=2026-01-02\r\ndraft=false\r\n+++\r\n# Body');
  assert.equal(parsed.data.title, 'Example');
  assert.equal(parsed.data.draft, false);
  assert.equal(parsed.body, '# Body');
  assert.throws(() => parseFrontmatter('+++\ntitle =\n+++', 'broken.md'), /broken\.md/);
  assert.throws(() => parseFrontmatter('# No header'), /frontmatter/);
});

test('source links, bundle paths and external links retain their destinations', () => {
  assert.equal(resolveContentUrl('@/articles/other/index.md#heading', context), '/articles/other/#heading');
  assert.equal(resolveContentUrl('image%201.png', context), '/articles/example/image%201.png');
  assert.equal(resolveContentUrl('/img/pic.svg', context), '/img/pic.svg');
  assert.equal(resolveContentUrl('https://example.org/a', context), 'https://example.org/a');
  assert.throws(() => resolveContentUrl('@/missing.md', context), /Unknown content reference/);
  const { html } = renderMarkdown('[本站](@/articles/other/index.md)\n\n[外站](https://other.test/)\n\n![图片](cover.png)', context);
  assert.match(html, /href="\/articles\/other\/"/);
  assert.match(html, /target="_blank" rel="noopener nofollow"/);
  assert.match(html, /src="\/articles\/example\/cover.png"[^>]*loading="lazy"/);
});

test('heading anchors remain compatible with existing Chinese URLs and duplicate headings', () => {
  assert.equal(slugify('背景'), 'bei-jing');
  const result = renderMarkdown('# 背景\n\n## 内容\n\n# 背景\n\n# 填坑 {#填坑}', context);
  assert.deepEqual(result.toc.map(item => item.id), ['bei-jing', 'bei-jing-1', '填坑']);
  assert.equal(result.toc[0].children[0].id, 'nei-rong');
  assert.match(result.html, /class="heading-anchor" href="#bei-jing"/);
  assert.doesNotMatch(result.html, /\{#填坑\}/);
});

test('shortcodes render outside code while code samples and raw HTML remain intact', () => {
  const result = renderMarkdown('{{ image(img_name="pic.png", width=300, alt="A & B") }}\n\n`{{ image(img_name="literal.png") }}`\n\n```tera\n{{ image(img_name="code.png") }}\n{% if foo %}{{ secrets.TOKEN }}{% endif %}\n```\n\n<iframe src="https://example.org/embed"></iframe>\n\n:smile:', context);
  assert.match(result.html, /max-width:300px/);
  assert.match(result.html, /src="\/articles\/example\/pic.png"/);
  assert.match(result.html, /alt="A &amp; B"/);
  assert.match(result.html, /<code>\{\{ image/);
  assert.match(result.html, /class="language-tera" data-lang="tera"/);
  assert.match(result.html, /\{\{ secrets.TOKEN \}\}/);
  assert.doesNotMatch(result.html, /src="[^\"]*(literal|code)\.png"/);
  assert.match(result.html, /<iframe src="https:\/\/example.org\/embed"><\/iframe>/);
  assert.match(result.html, /😄/);
});

test('table, footnote and subscription shortcode output is usable', () => {
  const { html } = renderMarkdown('| A | B |\n| - | - |\n| 1 | 2 |\n\nText[^note]\n\n[^note]: Footnote\n\n{{ subscribe_list() }}', context);
  assert.match(html, /<table>/);
  assert.match(html, /footnote/);
  assert.match(html, /rss-plan-list/);
  assert.match(html, /公众号订阅/);
});

test('subscription URLs follow the configured default language and explicit overrides', () => {
  const english = { ...context, config: { ...config, default_language: 'en' }, document: { ...context.document, lang: 'en' } };
  const defaultHtml = renderMarkdown('{{ subscribe_list() }}', english).html;
  assert.match(defaultHtml, /href="\/wechat\/"/);
  assert.match(defaultHtml, /href="\/rss.xml"/);
  assert.doesNotMatch(defaultHtml, /href="\/en\//);
  const translatedHtml = renderMarkdown('{{ subscribe_list() }}', { ...english, config: { ...config, default_language: 'zh-CN' } }).html;
  assert.match(translatedHtml, /href="\/en\/wechat\/"/);
  assert.match(translatedHtml, /href="\/en\/rss.xml"/);
  const customHtml = renderMarkdown('{{ subscribe_list() }}', { ...english, config: { ...english.config, extra: { subscribe: { rss_url: 'https://rss.test/feed' } } } }).html;
  assert.match(customHtml, /href="https:\/\/rss.test\/feed"/);
});

test('reading analytics preserve Zola Unicode counting and its 200-word reading speed', () => {
  assert.deepEqual(readingAnalytics('  '), { wordCount: 0, readingTime: 0 });
  assert.deepEqual(readingAnalytics(' Hello world'.repeat(1000)), { wordCount: 2000, readingTime: 10 });
  assert.deepEqual(readingAnalytics('hello world ``` code goes here ``` goodbye world ``` dangling fence'), { wordCount: 4, readingTime: 1 });
  assert.deepEqual(readingAnalytics('你好世界 Hello can’t 32.3'), { wordCount: 7, readingTime: 1 });
  assert.equal(readingAnalytics('word '.repeat(201)).readingTime, 2);
});

test('draft ancestors are private while metadata, explicit HTML aliases and locale paths survive', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'astro-content-'));
  try {
    await mkdir(path.join(root, 'content', 'private', 'bundle'), { recursive: true });
    await writeFile(path.join(root, 'config.toml'), 'base_url="https://example.com"\ndefault_language="zh-CN"\n[languages.en]\ntitle="English"\n[slugify]\npaths="safe"');
    await writeFile(path.join(root, 'content', '_index.md'), '+++\ntitle="Home"\n+++\n');
    await writeFile(path.join(root, 'content', 'private', '_index.md'), '+++\ndraft=true\nchild_layout="post"\n+++\n');
    await writeFile(path.join(root, 'content', 'private', 'bundle', 'index.md'), '+++\ntitle="Private"\npath="custom"\naliases=["old.html"]\n+++\nHello');
    await writeFile(path.join(root, 'content', 'private', 'bundle', 'index.en.md'), '+++\ntitle="English"\npath="en/custom"\n+++\nHello');
    await writeFile(path.join(root, 'content', 'private', 'bundle', 'cover.png'), 'test-image');
    const published = await loadSite({ root });
    assert.equal(published.documents.length, 0);
    assert.equal(published.sections.length, 2);
    assert.equal(published.assets.length, 0);
    const preview = await loadSite({ root, includeDrafts: true });
    assert.equal(preview.documents.length, 2);
    assert.ok(preview.documents.every(doc => doc.draft));
    assert.ok(preview.documents.find(doc => doc.lang === 'zh-CN')!.aliases.includes('/old.html'));
    assert.equal(preview.documents[0].translations.length, 1);
    assert.equal(preview.assets.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('deployment URL override reaches the content configuration used by feeds and metadata', async () => {
  const previous=process.env.ASTRO_SITE_URL;
  try {
    process.env.ASTRO_SITE_URL='https://preview.example.test/';
    const site=await loadSite({root:repository});
    assert.equal(site.config.base_url,'https://preview.example.test');
    assert.equal(localeConfig(site,'en').base_url,'https://preview.example.test');
  } finally {
    if(previous===undefined)delete process.env.ASTRO_SITE_URL;
    else process.env.ASTRO_SITE_URL=previous;
  }
});

test('Markdown task lists retain disabled checkboxes until a page enables interaction', () => {
  const {html}=renderMarkdown('- [ ] One\n- [x] Two\n  - [ ] Nested',context);
  assert.equal([...html.matchAll(/type="checkbox"/g)].length,3);
  assert.match(html,/checked=""/);
  assert.match(html,/disabled=""/);
  assert.doesNotMatch(html,/<li>\[ \]/);
});


test('site-owned heading aliases remain inside headings without duplication', () => {
  const ctx={...context,config:{...config,headingAliases:{'/articles/example/':{'new-heading':'old-heading'}}}};
  assert.match(renderMarkdown('## New heading',ctx).html,/<h2[^>]*><span id="old-heading"/);
  assert.equal([...renderMarkdown('# Existing {#old-heading}\n\n## New heading',ctx).html.matchAll(/id="old-heading"/g)].length,1);
});


test('non-default language case is preserved in URLs and translation links', async () => {
  const site = await loadSite({root: repository});
  const source = site.documents.find(doc => doc.relativePath === 'articles/welcome/index.md')!;
  const translation = source.translations.find(doc => doc.lang === 'zh-CN')!;
  assert.equal(translation.url, '/zh-CN/articles/welcome/');
  assert.ok(site.sections.some(doc => doc.url === '/zh-CN/articles/'));
  assert.ok([...site.documents, ...site.sections].every(doc => !doc.url.startsWith('/zh-cn/')));
});
