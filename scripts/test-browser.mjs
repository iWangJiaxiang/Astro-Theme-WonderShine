import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demo = {
  siteRoot: path.join(workspace, 'examples/demo'),
  pages: [
    ['home', '/'], ['article', '/articles/welcome/'],
    ['thread', '/thread/11111111-2222-4333-8444-555555555555/'],
    ['series', '/collections/field-notes/'], ['tags', '/tags/design/'],
    ['chinese', '/zh-CN/'],
  ],
  navigation: { path: '/articles/', language: 'zh-CN', translatedPath: '/zh-CN/articles/' },
};

export async function checkBrowser(options = demo) {
  const siteRoot = path.resolve(options.siteRoot);
  const screenshots = path.resolve(process.env.WONDERSHINE_SCREENSHOTS || options.screenshots || 'temp/browser');
  await mkdir(screenshots, { recursive: true });
  const requireSite = createRequire(path.join(siteRoot, 'package.json'));
  const astro = path.join(path.dirname(requireSite.resolve('astro/package.json')), 'bin/astro.mjs');
  const reserve = createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [astro, 'preview', '--root', siteRoot, '--host', '127.0.0.1', '--port', String(port)], {
    cwd: siteRoot, env: { ...process.env, ASTRO_PREVIEW_BACKGROUND: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '', spawnError, browser;
  server.stderr.on('data', value => { logs += value; });
  server.stdout.on('data', value => { logs += value; });
  server.on('error', error => { spawnError = error; });
  try {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (spawnError) throw spawnError;
      if (server.exitCode !== null) throw new Error(`Preview exited: ${logs}`);
      try { if ((await fetch(origin)).ok) break; } catch {}
      if (attempt === 149) throw new Error(`Preview did not start: ${logs}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const executablePath = process.env.STUDIO_TEST_BROWSER || [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium-browser',
    ].find(existsSync);
    assert.ok(executablePath, 'Set STUDIO_TEST_BROWSER to a Chrome executable');
    browser = await puppeteer.launch({ headless: true, executablePath });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const failures = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (response.url().startsWith(origin) && response.status() >= 400) failures.push(`${response.url()} ${response.status()}`);
    });
    // Local assets and interactions are deterministic; external services are tested separately.
    await page.setRequestInterception(true);
    page.on('request', request => request.url().startsWith(origin) || request.url().startsWith('data:') ? request.continue() : request.abort());
    const settled = () => page.waitForFunction(() => {
      const background = document.querySelector('#loading-box .loading-bg');
      return (!background || getComputedStyle(background).visibility === 'hidden') && !document.documentElement.hasAttribute('data-astro-transition');
    });
    for (const [name, route] of options.pages) {
      const response = await page.goto(origin + route, { waitUntil: 'networkidle0' });
      assert.equal(response.status(), 200, route);
      await settled();
      await page.screenshot({ path: path.join(screenshots, `blog-${name}.png`) });
      const broken = await page.$$eval('img', images => images.filter(image => image.offsetParent && image.complete && !image.naturalWidth && image.src.startsWith(location.origin)).map(image => image.src));
      assert.deepEqual(broken, [], route);
    }
    await page.goto(origin, { waitUntil: 'networkidle0' });
    await settled();
    await page.evaluate(() => { window.__navigationProbe = 'persistent'; });
    const navigation = options.navigation;
    await page.locator(`a[href="${navigation.path}"]`).click();
    await page.waitForFunction(expected => location.pathname === expected, {}, navigation.path);
    await settled();
    assert.equal(await page.evaluate(() => window.__navigationProbe), 'persistent', 'ClientRouter must preserve document');
    await page.locator('details.nav-language-switch summary').click();
    await page.locator(`.nav-language-option[hreflang="${navigation.language}"]`).click();
    await page.waitForFunction(expected => location.pathname === expected, {}, navigation.translatedPath);
    await settled();
    assert.equal(await page.evaluate(() => window.__navigationProbe), 'persistent', 'Language switch must preserve document');
    for (const [name, width, height] of [['medium', 1165, 773], ['mobile', 390, 844]]) {
      await page.setViewport({ width, height });
      await page.goto(origin, { waitUntil: 'networkidle0' });
      await settled();
      await page.screenshot({ path: path.join(screenshots, `blog-${name}.png`) });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: horizontal overflow`);
    }
    assert.deepEqual(failures, [], 'Local HTTP failures');
    assert.deepEqual(errors, [], 'Browser exceptions');
    const report = { pages: options.pages.length, clientRouter: 'passed', languageSwitch: 'passed', responsiveWidths: [1165, 390], errors, failures };
    await writeFile(path.join(screenshots, 'browser.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options = demo;
  if (process.argv[2]) {
    const config = path.resolve(process.argv[2]);
    options = JSON.parse(await readFile(config, 'utf8'));
    options.siteRoot = path.resolve(path.dirname(config), options.siteRoot);
  }
  await checkBrowser(options);
}
