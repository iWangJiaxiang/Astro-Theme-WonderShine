import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAstro } from '../astro-build.ts';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchToml, removeTomlFields } from '../../server/content.ts';
import { ContentService } from '../../server/content-service.ts';
import { LocalRepository } from '../../server/repository.ts';

const theme = fileURLToPath(new URL('../../../../examples/demo/', import.meta.url));

// Render the production Astro application against disposable Studio-created content.
async function site(t, values = {}) {
  const root = await mkdtemp(join(tmpdir(), 'studio-templates-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root,'config.toml'), 'base_url="https://example.com"\ndefault_language="zh-CN"\n[languages.en]\ntitle="English"\n');
  await writeFile(join(root,'data.toml'), '');
  for (const [file, layout, route, body] of [['content/_index.md','index','/',''],['content/articles/_index.md','archives','/articles/',''],['content/pages/wechat.md','wechat','/wechat/',''],['content/pages/subscribe.md','empty','/subscribe/','{{ subscribe_list() }}']]) {
    await mkdir(join(root,file,'..'),{recursive:true});
    await writeFile(join(root,file), '+++\ntitle="Fixture"\nlayout="'+layout+'"\npath="'+route+'"\n+++\n'+body);
  }
  const config = join(root, 'config.toml');
  const patch = async values => writeFile(config, patchToml(await readFile(config, 'utf8'), values));
  await patch({ base_url: 'https://example.com', minify_html: false, ...values });
  return {
    root, patch,
    build() { buildAstro(root); },
    // Normalize legacy escaped attributes without unescaping content text.
    html: async path => (await readFile(join(root, 'dist', path, 'index.html'), 'utf8')).replaceAll('&#x2F;', '/'),
  };
}

test('published articles with empty categories build while categorized recommendations remain intact', async t => {
  const fixture = await site(t);
  const articles = {
    'empty-categories': '[taxonomies]\ntags=[]\ncategories=[]',
    'category-one': '[taxonomies]\ntags=[]\ncategories=["template-regression"]',
    'category-two': '[taxonomies]\ntags=[]\ncategories=["template-regression"]',
  };
  for (const [slug, taxonomy] of Object.entries(articles)) {
    const dir = join(fixture.root, 'content/articles', slug);
    await mkdir(dir, { recursive: true });
    // No draft field: existing published content must remain buildable.
    await writeFile(join(dir, 'index.md'), `+++\ntitle="${slug}"\ndate=2026-01-01\n${taxonomy}\n+++\nPublished regression body.\n`);
  }
  for (const mode of ['two', 'six']) {
    await fixture.patch({ 'extra.post.recommendQuantity': mode });
    fixture.build();
    const uncategorized = await fixture.html('articles/empty-categories');
    assert.match(uncategorized, /Published regression body\./);
    assert.doesNotMatch(uncategorized, /class="relatedPosts"/);
    const html = await fixture.html('articles/category-one');
    const related = html.match(/<div class="relatedPosts">[\s\S]*?<link[^>]+related-posts-[^>]+>/)?.[0];
    assert.ok(related, `related posts still render in ${mode} mode`);
    assert.match(related, /href="[^"]*\/articles\/category-two\/"/);
    assert.doesNotMatch(related, /href="[^"]*\/articles\/category-one\/"/);
    assert.match(related, new RegExp(`related-posts-${mode}\\.css`));
  }
});

test('published articles can omit categories or the whole taxonomies table', async t => {
  const fixture = await site(t);
  for (const [slug, taxonomy] of [['missing-categories', '[taxonomies]\ntags=[]'], ['missing-taxonomies', '']]) {
    const dir = join(fixture.root, 'content/articles', slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.md'), `+++\ntitle="${slug}"\ndate=2026-01-01\n${taxonomy}\n+++\nPublished regression body.\n`);
  }
  fixture.build();
  for (const slug of ['missing-categories', 'missing-taxonomies']) {
    const html = await fixture.html('articles/' + slug);
    assert.match(html, /Published regression body\./);
    assert.doesNotMatch(html, /class="relatedPosts"/);
  }
});

test('WeChat page renders every saved page setting and escapes text', async t => {
  const fixture = await site(t, {
    'extra.wechat.qrcode': '/img/wechat.svg',
    'extra.wechat.avatar': '/img/custom-avatar.webp',
    'extra.wechat.name': 'Studio WeChat & <name>',
    'extra.wechat.description': 'Studio description & <description>',
    'extra.wechat.tips': 'Studio scan & <tips>',
    'extra.wechat.help_text': 'Studio help & <help>',
    'extra.wechat.help_url': 'https://example.com/wechat-help',
  });
  fixture.build();
  const html = (await fixture.html('wechat')).match(/<(?:div|main) class="wechatOA"[\s\S]*?<\/a>/)?.[0] || '';
  assert.match(html, /class="wechatOA-name">Studio WeChat &amp; &lt;name&gt;<\/div>/);
  assert.match(html, /class="wechatOA-description">Studio description &amp; &lt;description&gt;<\/div>/);
  assert.match(html, /class="tips">Studio scan &amp; &lt;tips&gt;<\/div>/);
  assert.match(html, /class="qrcode progressive-picture">[\s\S]*?src="\/img\/wechat.svg"/);
  assert.match(html, /class="wechatOA-head"[^>]*\/img\/custom-avatar.webp/);
  assert.match(html, /href="https:\/\/example.com\/wechat-help"[^>]*>Studio help &amp; &lt;help&gt;<\/a>/);
});

test('WeChat legacy and partial configurations retain defaults and author/logo fallbacks', async t => {
  const fixture = await site(t, { author: 'Fallback author', 'extra.site.logo': '/img/fallback-logo.webp' });
  await mkdir(join(fixture.root, 'public/img'), { recursive: true });
  await cp(fileURLToPath(new URL('../../../../packages/theme/assets/img/logo.svg', import.meta.url)), join(fixture.root, 'public/img/fallback-logo.webp'));
  for (const settings of [null, { 'extra.wechat.name': '', 'extra.wechat.avatar': '' }]) {
    if (settings) await fixture.patch(settings);
    fixture.build();
    const html = (await fixture.html('wechat')).match(/<(?:div|main) class="wechatOA"[\s\S]*?<\/a>/)?.[0] || '';
    assert.match(html, /class="wechatOA-name">Fallback author<\/div>/);
    assert.match(html, /class="wechatOA-head"[^>]*\/img\/fallback-logo.webp/);
    assert.match(html, /class="wechatOA-description">跨界 无极限<\/div>/);
    assert.match(html, /尚未设置公众号二维码/);
    assert.doesNotMatch(html, /class="qrcode progressive-picture"/);
    assert.match(html, /href="https:\/\/kf.qq.com\/touch\/wxappfaq\/1208117b2mai141113jaqAnU.html\?platform=14"[^>]*>不会扫码？<\/a>/);
  }
});

test('WeChat accepts remote QR images and avatar filenames containing quotes', async t => {
  const fixture = await site(t, {
    'extra.wechat.qrcode': 'https://example.invalid/qr.png?one=1&two=2',
    'extra.wechat.avatar': "/img/owner's.webp",
  });
  await mkdir(join(fixture.root, 'public/img'), { recursive: true });
  await cp(fileURLToPath(new URL('../../../../packages/theme/assets/img/logo.svg', import.meta.url)), join(fixture.root, "public/img/owner's.webp"));
  fixture.build();
  const html = (await fixture.html('wechat')).match(/<(?:div|main) class="wechatOA"[\s\S]*?<\/a>/)?.[0] || '';
  assert.match(html, /class="qrcode progressive-picture">[\s\S]*?<img[^>]+src="https:\/\/example.invalid\/qr.png\?one=1&amp;two=2"/);
  assert.match(html, /<img class="wechatOA-head" src="\/img\/owner(?:&#x27;|&#39;|')s.webp"/);
  assert.ok((await readFile(join(fixture.root, "dist/img/owner's.webp"))).length > 0);
});

test('subscription cards render configured URLs with HTML escaping', async t => {
  const fixture = await site(t, {
    'extra.subscribe.wechat_url': '/custom-wechat/',
    'extra.subscribe.follow_url': 'https://example.com/follow?one=1&two=2',
    'extra.subscribe.rss_url': '/custom-feed.xml',
  });
  fixture.build();
  const html = await fixture.html('subscribe');
  assert.match(html, /<div class="rss-plan-list">/);
  assert.match(html, /class="rss-plan-item rss-plan-wechat" href="\/custom-wechat\/"/);
  assert.match(html, /class="rss-plan-item rss-plan-mail" href="https:\/\/example.com\/follow\?one=1&amp;two=2"/);
  assert.match(html, /class="rss-plan-item rss-plan-rss" href="\/custom-feed.xml"/);
});

test('subscription cards retain legacy defaults when settings are absent', async t => {
  const fixture = await site(t);
  fixture.build();
  const html = await fixture.html('subscribe');
  assert.match(html, /<div class="rss-plan-list">/);
  assert.match(html, /class="rss-plan-item rss-plan-wechat" href="\/wechat\/"/);
  assert.doesNotMatch(html, /rss-plan-mail|app.follow.is/);
  assert.match(html, /class="rss-plan-item rss-plan-rss" href="\/rss.xml"/);
});

test('Studio SEO and typography settings reach Astro without replacing article or translated descriptions', async t => {
  const fixture = await site(t, { 'languages.en.description': 'English site description' });
  const service = new ContentService(new LocalRepository(fixture.root));
  for (const [id, changes] of [
    ['site', { 'extra.site.seo': 'Studio SEO & description' }],
    ['appearance', { 'extra.style.font_family': 'Georgia, serif' }],
  ]) {
    const settings = await service.settings(id);
    await service.saveSettings(id, changes, settings.revision);
  }
  await service.saveDocument('content/pages/compatibility/index.md', {
    title: 'Compatibility', description: 'Article-specific description', draft: false,
  }, 'Body', null);
  await service.saveDocument('content/pages/compatibility/index.en.md', {
    title: 'English compatibility', draft: false,
  }, 'English body', null);
  fixture.build();
  const home = await fixture.html('');
  assert.match(home, /<meta name="description" content="Studio SEO &amp; description"/);
  assert.match(home, /--site-font-family:Georgia, serif/);
  assert.match(home, /body\{font-family:var\(--site-font-family\)/);
  assert.match(await fixture.html('pages/compatibility'), /<meta name="description" content="Article-specific description"/);
  assert.match(await fixture.html('en/pages/compatibility'), /<meta name="description" content="English site description"/);
  await fixture.patch({
    'extra.style.font_family': '</style><script>window.fontInjected=true</script>',
    'extra.locale.en.site.seo': 'English SEO override',
  });
  fixture.build();
  const safeHome = await fixture.html('');
  assert.doesNotMatch(safeHome, /id="wjx-font-styles"|window\.fontInjected/);
  assert.match(await fixture.html('en/pages/compatibility'), /<meta name="description" content="English SEO override"/);
});

test('a site without authored SEO keeps its description instead of the theme demo text', async t => {
  const fixture = await site(t, { default_language: 'en', description: 'My English site description' });
  const config = join(fixture.root, 'config.toml');
  await writeFile(config, removeTomlFields(await readFile(config, 'utf8'), ['extra.site.seo']));
  fixture.build();
  assert.match(await fixture.html(''), /<meta name="description" content="My English site description"/);
});
