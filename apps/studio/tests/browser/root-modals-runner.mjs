import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../../server/password.ts';
import { checkRootModals } from './root-modals.mjs';
import { checkNavigationContext } from './navigation-context.mjs';

// Remote-CI entry point. Uses an already-built Studio; never builds Astro or Studio.
const studio = fileURLToPath(new URL('../../', import.meta.url));
const base = await mkdtemp(join(tmpdir(), 'studio-root-modals-'));
const screenshots = join(studio, 'test-results');
let server, browser, page;
try {
  const site = join(base, 'site');
  await mkdir(join(site, 'content/articles/example'), { recursive: true });
  await mkdir(screenshots, { recursive: true });
  await writeFile(join(site, 'config.toml'), 'title="Modal test"\nbase_url="https://example.com"\n');
  await writeFile(join(site, 'data.toml'), '[post]\ntags=[]\ncategories=[]\n');
  await writeFile(join(site, 'content/articles/example/index.md'), '+++\ntitle="Example"\ndraft=true\n+++\nExample text.\n');
  // Force SelectionField's native chooser instead of its <=5 inline radio tiles.
  for (let i = 0; i < 6; i++) {
    const directory = join(site, `content/collections/modal-collection-${i}`);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, '_index.md'), `+++\ntitle="Modal collection ${i}"\nlayout="collection-detail"\n+++\n`);
  }
  // Populate before server startup so both suites exercise the real cached
  // content/media APIs, without mutating fixtures underneath an active app.
  // Example remains first (undated titles sort alphabetically), as required by
  // the modal suite. Two-plus pages make narrow library scrolling meaningful.
  for (let i = 0; i < 48; i++) {
    const slug = `navigation-context-${String(i).padStart(2, '0')}`;
    const directory = join(site, 'content/articles', slug);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'index.md'), `+++\ntitle="Navigation context ${String(i).padStart(2, '0')}"\ndraft=true\n+++\n${Array.from({ length: 100 }, (_, line) => `Navigation context body line ${line}.`).join('\n')}\n`);
  }
  await mkdir(join(site, 'public/img'), { recursive: true });
  await writeFile(join(site, 'public/img/navigation-context.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQqTrzHwAEmgJqoFzzQgAAAABJRU5ErkJggg==', 'base64'));
  const reserve = createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const origin = `http://localhost:${port}`, password = randomBytes(24).toString('hex');
  server = spawn(process.execPath, ['dist/server.mjs'], { cwd: studio, env: { ...process.env,
    STUDIO_ORIGIN: origin, PORT: String(port), STUDIO_HOST: '127.0.0.1', STUDIO_SITE_ROOT: site,
    STUDIO_STATE: 'file', STUDIO_STATE_DIR: join(base, 'state'), STUDIO_GIT_URL: '', STUDIO_OIDC_ISSUER: '',
    STUDIO_ADMIN_USER: 'owner', STUDIO_ADMIN_PASSWORD_HASH: await hashPassword(password), STUDIO_SESSION_SECRET: randomBytes(32).toString('hex'),
  }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(origin + '/api/auth/config')).ok) break; } catch { /* Wait for fixture server. */ }
    if (i === 99) throw new Error('Root-modal fixture did not start');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const executablePath = process.env.STUDIO_TEST_BROWSER || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
  if (!executablePath) throw new Error('Set STUDIO_TEST_BROWSER to a Chromium executable.');
  browser = await puppeteer.launch({ headless: true, executablePath });
  page = await browser.newPage();
  const errors = [], warnings = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (/Cannot update a component|Invalid DOM property|Each child in a list|You provided a .*prop/i.test(message.text())) warnings.push(message.text());
  });
  const acceptDialog = dialog => dialog.accept();
  page.on('dialog', acceptDialog);
  await page.evaluateOnNewDocument(() => Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN'] }));
  const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0], split = cookie.indexOf('=');
  await browser.setCookie({ name: cookie.slice(0, split), value: cookie.slice(split + 1), domain: 'localhost', path: '/', httpOnly: true });
  await page.goto(origin, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.studio-shell');
  await checkRootModals({ page, origin, password, screenshots });
  await checkNavigationContext({ page, origin, screenshots, acceptDialog });
  assert.deepEqual(errors, [], 'No page/lifecycle errors');
  assert.deepEqual(warnings, [], 'No React warnings');
} catch (error) {
  if (page) await page.screenshot({ path: join(screenshots, 'root-modal-failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise(resolve => server.once('exit', resolve)); }
  await rm(base, { recursive: true, force: true });
}
