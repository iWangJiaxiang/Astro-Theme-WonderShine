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
    window.updateFixture = { calls: 0, opened: [], fail: false, available: true };
    createRoot(document.getElementById('root')!).render(<StrictMode><NativeUpdates /></StrictMode>);
  ` },
  bundle: true, platform: 'browser', format: 'iife', write: false, outdir: 'out', jsx: 'automatic',
  loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl', '.gif': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env.VITE_STUDIO_RELEASE_REPOSITORY': '"example/studio"', 'import.meta.env.VITE_STUDIO_IOS_UPDATE_URL': '""' },
  plugins: [{ name: 'native-update-fixture', setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/(api\/app|plugin-http|plugin-opener)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents:
      args.path.endsWith('api/app') ? 'export const getVersion = async () => "0.1.0";' :
      args.path.endsWith('plugin-opener') ? 'export const openUrl = async url => { window.updateFixture.opened.push(url); };' :
      `export async function fetch() {
        window.updateFixture.calls++;
        if (window.updateFixture.fail) return new Response('', { status: 403 });
        if (!window.updateFixture.available) return Response.json([]);
        return Response.json([{ tag_name: 'studio-v0.2.0', html_url: 'https://github.com/example/studio/releases/tag/studio-v0.2.0', draft: false, prerelease: false, assets: [{ name: 'studio-release.json', state: 'uploaded', size: 200 }] }]);
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
  for (const width of [1440, 1024, 390]) {
    await page.setViewport({ width, height: 850, deviceScaleFactor: 1 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(out, `update-${width}.png`), fullPage: true });
  }
  await page.click('.native-update-notice .primary');
  assert.deepEqual(await page.evaluate(() => window.updateFixture.opened), ['https://github.com/example/studio/releases/tag/studio-v0.2.0']);
  await page.click('.native-update-skip');
  await page.reload();
  await page.waitForFunction(() => window.updateFixture?.calls === 1);
  await page.waitForFunction(() => !document.querySelector('.native-update-footer button').disabled);
  assert.equal(await page.$('.native-update-notice'), null, 'Skipped version must stay dismissed across launches');
  await page.click('.native-update-footer button');
  await page.waitForSelector('.native-update-notice');
  await page.evaluate(() => { window.updateFixture.available = false; });
  await page.waitForFunction(() => !document.querySelector('.native-update-footer button').disabled);
  await page.click('.native-update-footer button');
  await page.waitForFunction(() => !document.querySelector('.native-update-notice'));
  assert.match(await page.$eval('.native-update-footer [role=status]', el => el.textContent), /No update|未发现/);
  await page.evaluate(() => { window.updateFixture.fail = true; });
  await page.click('.native-update-footer button');
  await page.waitForSelector('.native-update-footer [role=status]');
  assert.match(await page.$eval('.native-update-footer [role=status]', el => el.textContent), /Could not check|暂时无法/);
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
