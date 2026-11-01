import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import { prepareResponsiveImages, publishImageManifest } from '../scripts/responsive-images';
import { localImagePath, responsiveImage } from '../src/lib/image-assets';

test('local image URLs exclude remote, traversal and encoded unsafe paths', () => {
  assert.equal(localImagePath('/images/a%20b.png?v=2#photo'), '/images/a b.png');
  assert.equal(localImagePath('https://example.test/img/a.png', 'https://example.test'), '/img/a.png');
  for (const url of ['//remote.test/a.png', 'https://remote.test/a.png', '/img/%2e%2e/secret.png', '/img/%00.png', '/img/%5csecret.png', 'data:image/png;base64,abc', 'relative.png']) {
    assert.equal(localImagePath(url, 'https://example.test'), undefined, url);
  }
});

test('responsive images retain originals, deduplicate, cache encodes and expose safe fallbacks', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'astro-images-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'public');
  await mkdir(path.join(output, 'articles/example'), { recursive: true });
  const pixels = Buffer.alloc(900 * 600 * 3);
  for (let y = 0; y < 600; y++) for (let x = 0; x < 900; x++) {
    const offset = (y * 900 + x) * 3;
    pixels[offset] = x % 256; pixels[offset + 1] = y % 256; pixels[offset + 2] = (x + y) % 256;
  }
  const original = await sharp(pixels, { raw: { width: 900, height: 600, channels: 3 } }).png().toBuffer();
  const filename = path.join(output, 'articles/example/cover.png');
  await writeFile(filename, original);
  await writeFile(path.join(output, 'duplicate.png'), original);
  await writeFile(path.join(output, 'broken.png'), 'not-an-image');
  await writeFile(path.join(output, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const manifest = await prepareResponsiveImages(root, output);
  const metadata = manifest['/articles/example/cover.png'];
  assert.equal(metadata.width, 900);
  assert.equal(metadata.height, 600);
  assert.deepEqual(metadata.webp.map(item => item.width), [96, 240, 480, 800, 900]);
  assert.equal(metadata.avif.find(item => item.width === 480)!.bytes < original.length, true);
  assert.deepEqual(manifest['/duplicate.png'], metadata);
  assert.equal((await readdir(path.join(output, '_images'))).length, 10);
  assert.equal(manifest['/broken.png'], undefined);
  assert.equal(manifest['/icon.svg'], undefined);
  assert.deepEqual(await readFile(filename), original);
  for (const variant of [...metadata.webp, ...metadata.avif]) {
    const actual = await sharp(await readFile(path.join(output, variant.src))).metadata();
    assert.equal(actual.width, variant.width);
    assert.equal(actual.height, variant.height);
  }
  const cached = path.join(root, '.astro/images/cache', path.basename(metadata.webp[0].src));
  const before = (await stat(cached)).mtimeMs;
  const second = path.join(root, 'second');
  await cp(output, second, { recursive: true });
  assert.deepEqual(await prepareResponsiveImages(root, second), manifest);
  assert.equal((await stat(cached)).mtimeMs, before, 'unchanged images must not be encoded again');
  await publishImageManifest(root, manifest);
  const site = { root, config: { base_url: 'https://example.test' } };
  const image = responsiveImage(site, '/articles/example/cover.png', 480);
  assert.equal(image.original, '/articles/example/cover.png');
  assert.equal(image.src, metadata.webp[2].src);
  assert.match(image.avifSrcset!, /480w/);
  assert.equal(responsiveImage(site, 'https://remote.test/cover.png').src, 'https://remote.test/cover.png');
  assert.equal(responsiveImage(site, '/missing.png').src, '/missing.png');
  await publishImageManifest(root, {});
  assert.equal(responsiveImage(site, '/articles/example/cover.png').src, '/articles/example/cover.png');
  const previousManifest = process.env.ASTRO_IMAGE_MANIFEST_PATH;
  try {
    const scoped = path.join(output, '_images/manifest.json');
    process.env.ASTRO_IMAGE_MANIFEST_PATH = scoped;
    await publishImageManifest(root, manifest, scoped);
    assert.equal(responsiveImage(site, '/articles/example/cover.png', 480).src, metadata.webp[2].src);
    await publishImageManifest(root, {});
    assert.equal(responsiveImage(site, '/articles/example/cover.png', 480).src, metadata.webp[2].src, 'another output cannot replace the active snapshot metadata');
    await rm(scoped);
    assert.equal(responsiveImage(site, '/articles/example/cover.png').src, '/articles/example/cover.png');
  } finally {
    if (previousManifest === undefined) delete process.env.ASTRO_IMAGE_MANIFEST_PATH;
    else process.env.ASTRO_IMAGE_MANIFEST_PATH = previousManifest;
  }
});

test('small source images are never enlarged and changed bytes get new URLs', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'astro-images-small-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'public');
  await mkdir(output);
  const image = path.join(output, 'avatar.png');
  const write = async (background: string) => writeFile(image, await sharp({ create: { width: 40, height: 30, channels: 3, background } }).png().toBuffer());
  await write('#ff0000');
  const first = (await prepareResponsiveImages(root, output))['/avatar.png'];
  assert.deepEqual(first.webp.map(item => item.width), [40]);
  await write('#0000ff');
  const next = (await prepareResponsiveImages(root, output))['/avatar.png'];
  assert.notEqual(first.webp[0].src, next.webp[0].src);
});

test('truncated pixel data falls back to the original even when metadata is valid', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'astro-images-truncated-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'public');
  await mkdir(output);
  const png = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#22aa88' } }).png().toBuffer();
  const truncated = png.subarray(0, 100);
  assert.equal((await sharp(truncated).metadata()).width, 100, 'the fixture must pass header inspection');
  await assert.rejects(sharp(truncated).webp().toBuffer(), /read error|corrupt|truncated|end of/i);
  await writeFile(path.join(output, 'truncated.png'), truncated);
  const manifest = await prepareResponsiveImages(root, output);
  assert.equal(manifest['/truncated.png'], undefined);
  assert.deepEqual(await readFile(path.join(output, 'truncated.png')), truncated);
  await publishImageManifest(root, manifest);
  assert.equal(responsiveImage({ root, config: {} }, '/truncated.png').src, '/truncated.png');
});

test('filesystem write errors still reject image preparation', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'astro-images-write-error-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'public');
  await mkdir(output);
  await writeFile(path.join(output, 'image.png'), await sharp({ create: { width: 20, height: 20, channels: 3, background: '#abcdef' } }).png().toBuffer());
  const error = Object.assign(new Error('Test disk full'), { code: 'ENOSPC' });
  t.mock.method(fs, 'writeFile', async () => { throw error; });
  await assert.rejects(prepareResponsiveImages(root, output), error);
});

test('AVIF configuration selects encoders and separates cached recipe results', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'astro-images-format-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'public');
  await mkdir(output);
  await writeFile(path.join(output, 'avatar.png'), await sharp({ create: { width: 24, height: 16, channels: 3, background: '#996633' } }).png().toBuffer());
  const webpOnly = (await prepareResponsiveImages(root, output, { avif: false }))['/avatar.png'];
  assert.equal(webpOnly.avif.length, 0);
  assert.equal(webpOnly.webp.length, 1);
  assert.equal((await readdir(path.join(output, '_images'))).some(file => file.endsWith('.avif')), false);
  const dual = (await prepareResponsiveImages(root, output, { avif: true }))['/avatar.png'];
  assert.equal(dual.avif.length, 1);
  assert.notEqual(dual.webp[0].src, webpOnly.webp[0].src, 'format configuration is part of the cache recipe');
  await publishImageManifest(root, { '/avatar.png': dual });
  const site = { root, config: { extra: { other: { avif_enable: false } } } };
  assert.equal(responsiveImage(site, '/avatar.png').avifSrcset, undefined);
  assert.ok(responsiveImage(site, '/avatar.png').webpSrcset);
});
