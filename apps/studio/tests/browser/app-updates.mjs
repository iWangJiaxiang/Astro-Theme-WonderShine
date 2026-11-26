import { auditViewports } from './audit-viewports.mjs';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// Executed only by remote CI: exercise the actual component with native boundaries mocked.
const studio = fileURLToPath(new URL('../../', import.meta.url));
const out = join(studio, 'test-results/app-updates');
await mkdir(out, { recursive: true });
const fixture = await build({
  stdin: { resolveDir: studio, loader: 'tsx', contents: `
    import React, { StrictMode } from 'react';
    import { createRoot } from 'react-dom/client';
    import { NativeUpdates } from './platform/NativeUpdates';
    import './src/style.css';
    import './src/forms.css';
    import './src/i18n';
    window.updateFixture = { calls: 0, opened: [], fail: false, available: true, installer: false, downloads: [], installs: 0, unmetered: true };
    createRoot(document.getElementById('root')!).render(<StrictMode><NativeUpdates /></StrictMode>);
  ` },
  bundle: true, platform: 'browser', format: 'iife', write: false, outdir: 'out', jsx: 'automatic',
  loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl', '.gif': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env.VITE_STUDIO_RELEASE_REPOSITORY': '"example/studio"', 'import.meta.env.VITE_STUDIO_DESKTOP_UPDATER': '"true"', 'import.meta.env.VITE_STUDIO_IOS_UPDATE_URL': '""' },
  plugins: [{ name: 'native-update-fixture', setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/(api\/app|api\/core|plugin-http|plugin-opener)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents:
      args.path.endsWith('api/app') ? 'export const getVersion = async () => "0.1.0";' :
      args.path.endsWith('api/core') ? `
        export class Channel {}
        export async function invoke(name, args) {
          const fixture = window.updateFixture;
          if (name.endsWith('unmetered')) return fixture.unmetered;
          if (name.includes('download')) {
            fixture.downloads.push(args); args.progress.onmessage(args.name ? 100 : [100, 100]);
          } else if (name.includes('install')) fixture.installs++;
          else throw Error('unexpected command');
        }` :
      args.path.endsWith('plugin-opener') ? 'export const openUrl = async url => { window.updateFixture.opened.push(url); };' :
      `export async function fetch(url) {
        if (url.endsWith('/studio-release.json')) return Response.json({ version: '0.2.0', tag: 'studio-v0.2.0',
          assets: [{ platform: 'android', name: 'android-studio.apk', size: 61 * 1024 * 1024, sha256: 'b'.repeat(64) }] });
        window.updateFixture.calls++;
        if (window.updateFixture.fail) return new Response('', { status: 403 });
        if (!window.updateFixture.available) return Response.json([]);
        return Response.json([{ tag_name: 'studio-v0.2.0', html_url: 'https://github.com/example/studio/releases/tag/studio-v0.2.0', draft: false, prerelease: false, assets: ['studio-release.json', ...(window.updateFixture.installer ? ['studio-updater.json'] : [])].map(name => ({ name, state: 'uploaded', size: 200 })) }]);
      }`, loader: 'js' }));
  } }],
});
const js = fixture.outputFiles.find(file => file.path.endsWith('.js')).text;
const css = fixture.outputFiles.find(file => file.path.endsWith('.css')).text;
const server = createServer((req, res) => {
  if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(js); }
  else if (req.url === '/fixture.css') { res.setHeader('Content-Type', 'text/css'); res.end(css); }
  else res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const executablePath = process.env.STUDIO_TEST_BROWSER || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find(existsSync);
let browser;
try {
  browser = await puppeteer.launch({ headless: true, executablePath });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForSelector('.native-update-notice');
  assert.equal(await page.evaluate(() => window.updateFixture.calls), 1, 'StrictMode must not duplicate startup requests');
  const buttonStyle = await page.$eval('.native-update-notice .primary', el => {
    const style = getComputedStyle(el);
    return { foreground: style.color, background: style.backgroundColor };
  });
  assert.notEqual(buttonStyle.background, 'rgba(0, 0, 0, 0)', 'Update action must remain visible before a workspace theme is loaded');
  assert.notEqual(buttonStyle.foreground, buttonStyle.background);
  for (const { width, height, screenshot } of await auditViewports(page)) {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (screenshot) await page.screenshot({ path: join(out, `update-${width}.png`), fullPage: true });
  }
  await page.click('.native-update-notice .primary');
  assert.deepEqual(await page.evaluate(() => window.updateFixture.opened), ['https://github.com/example/studio/releases/tag/studio-v0.2.0']);
  await page.click('.native-update-skip');
  await page.reload();
  await page.waitForFunction(() => window.updateFixture?.calls === 1);
  await page.waitForFunction(() => !document.querySelector('.native-update-controls button').disabled);
  assert.equal(await page.$('.native-update-notice'), null, 'Skipped version must stay dismissed across launches');
  await page.click('.native-update-controls button');
  await page.waitForSelector('.native-update-notice');
  await page.evaluate(() => { window.updateFixture.available = false; });
  await page.waitForFunction(() => !document.querySelector('.native-update-controls button').disabled);
  await page.click('.native-update-controls button');
  await page.waitForFunction(() => !document.querySelector('.native-update-notice'));
  assert.match(await page.$eval('.native-update-controls [role=status]', el => el.textContent), /No update|未发现/);
  await page.evaluate(() => { window.updateFixture.fail = true; });
  await page.click('.native-update-controls button');
  await page.waitForSelector('.native-update-controls [role=alert]');
  assert.match(await page.$eval('.native-update-controls [role=alert]', el => el.textContent), /Could not check|暂时无法/);
  await page.evaluate(() => Object.assign(window.updateFixture, { available: true, fail: false, installer: true }));
  await page.click('.native-update-controls button');
  await page.waitForFunction(() => window.updateFixture.downloads.length === 1 && !document.querySelector('.primary').disabled);
  assert.equal(await page.evaluate(() => window.updateFixture.installs), 0);
  await page.setViewport({ width: 1024, height: 720 });
  await page.screenshot({ path: join(out, 'desktop-ready.png') });
  await page.evaluate(() => window.addEventListener('studio:before-install', event => event.preventDefault(), { once: true }));
  await page.click('.native-update-notice .primary');
  assert.equal(await page.evaluate(() => window.updateFixture.installs), 0);
  await page.click('.native-update-notice .primary');
  await page.waitForFunction(() => window.updateFixture.installs === 1);
  await page.click('.native-update-controls input');
  await page.reload();
  await page.waitForSelector('.native-update-controls input');
  assert.equal(await page.$eval('.native-update-controls input', el => el.checked), false);
  await page.evaluate(() => { window.updateFixture.installer = true; });
  await page.click('.native-update-controls button');
  await page.waitForSelector('.native-update-notice .primary:not(:disabled)');
  assert.equal(await page.evaluate(() => window.updateFixture.downloads.length), 0);
  await page.click('.native-update-notice .primary');
  await page.waitForFunction(() => window.updateFixture.installs === 1);
  await page.setUserAgent('Android Studio fixture');
  await page.reload();
  await page.waitForSelector('.native-update-controls input');
  await page.click('.native-update-controls input');
  await page.evaluate(() => Object.assign(window.updateFixture, { installer: true, unmetered: false }));
  await page.click('.native-update-controls button');
  await page.waitForSelector('.native-update-notice .primary:not(:disabled)');
  assert.equal(await page.evaluate(() => window.updateFixture.downloads.length), 0);
  await page.setViewport({ width: 360, height: 740 });
  await page.screenshot({ path: join(out, 'android-metered.png') });
  await page.click('.native-update-notice .primary');
  await page.waitForFunction(() => window.updateFixture.installs === 1);
  assert.equal(await page.evaluate(() => window.updateFixture.downloads[0].automatic), false);
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
