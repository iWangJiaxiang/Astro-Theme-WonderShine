import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const studio = new URL('../', import.meta.url);

test('production HTML declares the complete canonical Studio SVG favicon', async () => {
  const html = await readFile(new URL('index.html', studio), 'utf8');
  const head = html.match(/<head>([\s\S]*?)<\/head>/)?.[1];
  assert.ok(head, 'production head exists');
  const links = [...head.matchAll(/<link\b[^>]*>/g)].map(match => match[0]);
  const icons = links.filter(link => /\brel\s*=\s*["'][^"']*\bicon\b[^"']*["']/.test(link));
  assert.equal(icons.length, 1, 'exactly one explicit icon');
  const icon = icons[0];
  assert.match(icon, /^<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,[^"<>\s]+" \/>$/);
  const href = icon.match(/\bhref="([^"]+)"/)?.[1];
  assert.ok(href);
  const encoded = href.slice('data:image/svg+xml,'.length);
  const svg = decodeURIComponent(encoded);
  assert.equal(encoded, encodeURIComponent(svg), 'encoding preserves the HTML attribute boundary');
  const canonical = (await readFile(new URL('src-tauri/app-icon.svg', studio), 'utf8')).replace(/\r?\n$/, '');
  assert.equal(svg, canonical, 'favicon must not drift from the native brand source');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 128 128">/);
  assert.match(svg, /<title>WonderShine Studio<\/title>/);
  assert.match(svg, /<rect width="128" height="128" fill="#425aef"\/>/);
  assert.match(svg, /<path d="M24 39 39 89 64 55 89 89 104 39" fill="none" stroke="white" stroke-width="10" stroke-linejoin="round"\/>/);
  assert.doesNotMatch(svg, /<(?!\/?(?:svg|title|rect|path)\b)|\bon\w+\s*=|\b(?:href|style)\s*=|url\s*\(/i);
});

test('existing native image CSP permits the declared data favicon', async () => {
  const config = JSON.parse(await readFile(new URL('src-tauri/tauri.conf.json', studio), 'utf8'));
  const directives = config.app.security.csp.split(';').map((value: string) => value.trim().split(/\s+/));
  const imageDirectives = directives.filter((tokens: string[]) => tokens[0] === 'img-src');
  assert.equal(imageDirectives.length, 1);
  assert.ok(imageDirectives[0].includes('data:'), 'use the existing image policy without widening it');
});
