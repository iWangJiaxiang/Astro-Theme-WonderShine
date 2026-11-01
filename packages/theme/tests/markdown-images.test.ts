import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { publishImageManifest } from '../scripts/responsive-images';
import { renderMarkdown, type MarkdownContext } from '../src/lib/markdown';
import { responsiveSizes, type ImageManifest } from '../src/lib/image-assets';

const manifest: ImageManifest = {
  '/articles/example/photo.png': {
    width: 900, height: 600, originalBytes: 10_000,
    webp: [{ src: '/_images/photo-480.webp', width: 480, height: 320, bytes: 500 }, { src: '/_images/photo-900.webp', width: 900, height: 600, bytes: 900 }],
    avif: [{ src: '/_images/photo-480.avif', width: 480, height: 320, bytes: 300 }, { src: '/_images/photo-900.avif', width: 900, height: 600, bytes: 600 }],
  },
};

async function context(t: { after: (fn: () => Promise<void>) => void }): Promise<MarkdownContext> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'astro-markdown-images-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await publishImageManifest(root, manifest);
  return { root, document: { path: '/articles/example/', relativePath: 'articles/example/index.md', lang: 'en' }, config: { base_url: 'https://example.test' }, documentsBySource: new Map() };
}

test('Markdown local images have format choices, intrinsic dimensions and original lightbox URL', async t => {
  const html = renderMarkdown('![A & B](photo.png "Original title")', await context(t)).html;
  assert.match(html, /<picture[^>]*data-original="\/articles\/example\/photo.png"/);
  assert.match(html, /<source type="image\/avif"[^>]*photo-480.avif 480w[^>]*sizes="auto, /);
  assert.match(html, /<source type="image\/webp"/);
  assert.match(html, /<img[^>]*alt="A &amp; B"/);
  assert.match(html, /<img[^>]*title="Original title"/);
  assert.match(html, /<img[^>]*class="no-lightbox"/);
  assert.match(html, /<picture[^>]*data-caption="A &amp; B"/);
  assert.match(html, /<img[^>]*width="900"[^>]*height="600"/);
  assert.match(html, /<img[^>]*srcset="[^\"]*photo-900.webp 900w"/);
  assert.match(html, /<img[^>]*data-original="\/articles\/example\/photo.png"/);
});

test('AVIF opt-out applies to Markdown and shortcodes even with an older dual-format manifest', async t => {
  const ctx = await context(t);
  ctx.config.extra = { other: { avif_enable: false } };
  const html = renderMarkdown('![Photo](photo.png)\n\n{{ image(img_name="photo.png", width=480) }}', ctx).html;
  assert.doesNotMatch(html, /image\/avif|\.avif/);
  assert.equal((html.match(/<source type="image\/webp"/g) || []).length, 2);
  assert.match(html, /width="480" height="320"/);
  assert.match(html, /<img[^>]*class="progressive-content loaded no-lightbox"[^>]*srcset=/);
});

test('eager Markdown images never advertise auto sizes and unknown or remote images remain original', async t => {
  const ctx = await context(t);
  ctx.config.markdown = { lazy_async_image: false };
  const html = renderMarkdown('![Photo](photo.png)\n\n![Remote](https://remote.test/picture.png)\n\n![Missing](missing.png)', ctx).html;
  assert.doesNotMatch(html, /sizes="auto|loading="lazy"/);
  assert.equal((html.match(/<picture/g) || []).length, 1);
  assert.match(html, /src="https:\/\/remote.test\/picture.png"/);
  assert.match(html, /src="\/articles\/example\/missing.png"/);
});

test('shortcode display dimensions never upscale small originals', async t => {
  const html = renderMarkdown('{{ image(img_name="photo.png", width=1600) }}', await context(t)).html;
  assert.match(html, /max-width:900px/);
  assert.match(html, /width="900" height="600"/);
});

test('responsive sizes use rendered width only for lazy images and retain a fallback', () => {
  assert.equal(responsiveSizes('160px', 'lazy'), 'auto, 160px');
  assert.equal(responsiveSizes('auto, 160px', 'lazy'), 'auto, 160px');
  assert.equal(responsiveSizes('160px', 'eager'), '160px');
  assert.equal(responsiveSizes('auto, 160px', 'eager'), '160px');
});
