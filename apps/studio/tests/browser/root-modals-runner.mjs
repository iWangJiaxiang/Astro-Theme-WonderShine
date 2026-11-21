import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../../server/password.ts';
import { checkRootModals, ROOT_MODAL_OUTCOMES } from './root-modals.mjs';
import { checkNavigationContext } from './navigation-context.mjs';

// Remote-CI entry point. Uses an already-built Studio; never builds Astro or Studio.
const studio = fileURLToPath(new URL('../../', import.meta.url));

const workerPath = fileURLToPath(import.meta.url);
const outcomeBudget = 70_000;

async function bounded(operation, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}

function observeChild(child) {
  // Install immediately: spawn errors must never escape as unhandled events.
  return new Promise(resolve => {
    child.on('error', () => resolve({ spawnError: true }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function stopServer(server, settled) {
  if (!server?.pid || server.exitCode !== null || server.signalCode) return;
  server.kill('SIGTERM');
  try { await bounded(() => settled, 1000, 'Fixture server SIGTERM deadline'); }
  catch {
    server.kill('SIGKILL');
    await bounded(() => settled, 1000, 'Fixture server SIGKILL deadline');
  }
}

async function stopBrowser(browser, child, settled) {
  try {
    if (browser) await bounded(() => browser.close(), 1500, 'Fixture browser close deadline');
  } finally {
    browser?.disconnect();
    if (child?.pid && child.exitCode === null && !child.signalCode) {
      child.kill('SIGKILL');
      await bounded(() => settled, 1000, 'Fixture browser SIGKILL deadline');
    }
  }
}

async function runOutcome(outcome, base) {
  const screenshots = join(studio, 'test-results/root-modals', outcome);
  const controller = new AbortController();
  let server, serverSettled, chrome, chromeSettled, browser, page;
  const failures = [];
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
    await new Promise((resolve, reject) => {
      reserve.once('error', () => reject(new Error('Fixture port reservation failed')));
      reserve.listen(0, '127.0.0.1', resolve);
    });
    const port = reserve.address().port;
    await new Promise(resolve => reserve.close(resolve));
    const origin = `http://localhost:${port}`, password = randomBytes(24).toString('hex');
    // The limiter belongs to the server instance, not the session/browser. Each
    // outcome gets its own process, site, state and browser: four real logins,
    // without changing production limits or waiting/retrying around them.
    server = spawn(process.execPath, ['dist/server.mjs'], { cwd: studio, env: { ...process.env,
      STUDIO_ORIGIN: origin, PORT: String(port), STUDIO_HOST: '127.0.0.1', STUDIO_SITE_ROOT: site,
      STUDIO_STATE: 'file', STUDIO_STATE_DIR: join(base, 'state'), STUDIO_GIT_URL: '', STUDIO_OIDC_ISSUER: '',
      STUDIO_ADMIN_USER: 'owner', STUDIO_ADMIN_PASSWORD_HASH: await hashPassword(password), STUDIO_SESSION_SECRET: randomBytes(32).toString('hex'),
    }, stdio: 'ignore' });
    serverSettled = observeChild(server);
    let serverStopped = false;
    void serverSettled.then(() => { serverStopped = true; });
    const readyDeadline = Date.now() + 10_000;
    while (true) {
      if (serverStopped) throw new Error('Fixture server exited or failed to spawn');
      try {
        const response = await fetch(origin + '/api/auth/config', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1000)]) });
        await response.body?.cancel();
        if (response.ok) break;
      } catch { /* Bounded server readiness only; never retry authentication. */ }
      if (Date.now() >= readyDeadline) throw new Error('Root-modal fixture did not start');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const executablePath = process.env.STUDIO_TEST_BROWSER || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
    if (!executablePath) throw new Error('Set STUDIO_TEST_BROWSER to a Chromium executable.');
    // Spawn Chrome ourselves, non-detached, so the parent's process-group kill
    // includes it even when launch/connect never finishes. No stderr is logged.
    const profile = join(base, 'browser');
    await mkdir(profile, { recursive: true });
    const chromeArgs = await puppeteer.defaultArgs({ headless: true, userDataDir: profile, args: ['--remote-debugging-port=0'] });
    chrome = spawn(executablePath, chromeArgs, { stdio: 'ignore' });
    chromeSettled = observeChild(chrome);
    let chromeStopped = false;
    void chromeSettled.then(() => { chromeStopped = true; });
    const chromeDeadline = Date.now() + 10_000;
    let browserURL;
    while (!browserURL) {
      if (chromeStopped) throw new Error('Fixture browser exited or failed to spawn');
      try {
        const [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
        if (/^\d+$/.test(port)) browserURL = `http://127.0.0.1:${port}`;
      } catch { /* Wait for this disposable browser's debugging endpoint. */ }
      if (Date.now() >= chromeDeadline) throw new Error('Fixture browser did not start');
      if (!browserURL) await new Promise(resolve => setTimeout(resolve, 100));
    }
    browser = await puppeteer.connect({ browserURL });
    page = await browser.newPage();
    const errors = [], warnings = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (/Cannot update a component|Invalid DOM property|Each child in a list|You provided a .*prop/i.test(message.text())) warnings.push(message.text());
    });
    const acceptDialog = dialog => dialog.accept();
    page.on('dialog', acceptDialog);
    await page.evaluateOnNewDocument(() => Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN'] }));
    const login = await fetch(origin + '/api/auth/login', { method: 'POST', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]), headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password }) });
    assert.equal(login.status, 200, `${outcome}/initial: login status ${login.status}`);
    const cookie = login.headers.get('set-cookie').split(';')[0], split = cookie.indexOf('=');
    await browser.setCookie({ name: cookie.slice(0, split), value: cookie.slice(split + 1), domain: 'localhost', path: '/', httpOnly: true });
    await page.goto(origin, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.studio-shell');
    try {
      // Repeat all creation, AI and DELETE prerequisites for every outcome.
      await checkRootModals({ page, origin, password, screenshots, outcome });
      // Navigation runs once after the dirty-editor precondition; its suite
      // reloads the app to start with independent navigation memory.
      if (outcome === 'resume') await checkNavigationContext({ page, origin, screenshots, acceptDialog });
    } catch (error) { failures.push(error); }
    try { assert.deepEqual(errors, [], `${outcome}: no page/lifecycle errors`); }
    catch (error) { failures.push(error); }
    try { assert.deepEqual(warnings, [], `${outcome}: no React warnings`); }
    catch (error) { failures.push(error); }
  } catch (error) { failures.push(error); }
  finally {
    controller.abort();
    if (failures.length && page) {
      try { await bounded(() => page.screenshot({ path: join(screenshots, 'root-modal-failure.png'), fullPage: true }), 1000, 'Failure screenshot deadline'); }
      catch { failures.push(new Error(`${outcome}: failure screenshot unavailable`)); }
    }
    const cleanup = await Promise.allSettled([
      stopBrowser(browser, chrome, chromeSettled),
      stopServer(server, serverSettled),
    ]);
    for (const result of cleanup) if (result.status === 'rejected') failures.push(result.reason);
  }
  if (failures.length) throw new AggregateError(failures, `Root-modal fixture failed: ${outcome}`);
}

function signalGroup(child, signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

async function removeFixture(base) {
  // A separate cleanup process makes even stalled filesystem removal killable.
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    'import { rm } from "node:fs/promises"; await rm(process.argv[1], { recursive: true, force: true });', base], { stdio: 'ignore' });
  const settled = observeChild(child);
  try {
    const result = await bounded(() => settled, 1000, 'Fixture removal deadline');
    if (result.spawnError || result.code !== 0) throw new Error('Disposable fixture removal failed');
  } finally {
    if (child.pid && child.exitCode === null && !child.signalCode) {
      child.kill('SIGKILL');
      await bounded(() => settled, 1000, 'Fixture removal SIGKILL deadline');
    }
  }
}

async function isolatedOutcome(outcome) {
  const base = await bounded(() => mkdtemp(join(tmpdir(), `studio-root-modals-${outcome}-`)), 1000, 'Fixture directory deadline');
  const failures = [];
  let worker, settled;
  try {
    // Linux CI: one process group owns the worker, HTTP server and Chrome.
    // Killing this group stops the actual operations, not just a waiting promise.
    worker = spawn(process.execPath, [...process.execArgv, workerPath, '--root-modal-outcome', outcome, base], {
      cwd: studio, detached: true, stdio: ['ignore', 'inherit', 'inherit'],
    });
    settled = observeChild(worker);
    const result = await bounded(() => settled, outcomeBudget, `${outcome}: 70-second fixture deadline`);
    if (result.spawnError || result.code !== 0) throw new Error(`${outcome}: fixture worker failed`);
  } catch (error) { failures.push(error); }
  finally {
    if (worker) {
      try {
        // Always stop residual children, including after a worker setup failure.
        signalGroup(worker, 'SIGTERM');
        try { await bounded(() => settled, 1000, 'Fixture worker SIGTERM deadline'); }
        catch { /* Escalate below even if the worker itself already exited. */ }
      } catch (error) { failures.push(error); }
      finally {
        try {
          signalGroup(worker, 'SIGKILL');
          await bounded(() => settled, 1000, 'Fixture worker SIGKILL deadline');
        } catch (error) { failures.push(error); }
      }
    }
    // Only this outcome's mkdtemp-owned disposable directory is removed, after
    // terminating its process group. No shared user workspace is cleanup scope.
    try { await removeFixture(base); }
    catch { failures.push(new Error(`${outcome}: disposable fixture cleanup failed`)); }
  }
  if (failures.length) throw new AggregateError(failures, `Isolated outcome failed: ${outcome}`);
}

if (process.argv[2] === '--root-modal-outcome') {
  const outcome = process.argv[3], base = process.argv[4];
  assert.ok(ROOT_MODAL_OUTCOMES.includes(outcome) && base, 'Valid worker outcome and disposable directory required');
  // Fatal completion is intentional: no timed-out screenshot/CDP continuation
  // survives this worker. The parent also kills every remaining group member.
  try { await runOutcome(outcome, base); process.exit(0); }
  catch (error) { console.error(error); process.exit(1); }
} else {
  const completed = [], failures = [];
  for (const outcome of ROOT_MODAL_OUTCOMES) {
    try {
      await isolatedOutcome(outcome);
      completed.push(outcome);
    } catch (error) {
      // Still exercise remaining independent outcomes, without retrying any.
      failures.push(new Error(`Root-modal outcome failed: ${outcome}`, { cause: error }));
    }
  }
  // Three fixtures at <=75 seconds each, including parent cleanup, fit the
  // existing five-minute workflow cap without loosening any UI assertion.
  if (failures.length) throw new AggregateError(failures, 'Required root-modal outcome coverage failed');
  assert.deepEqual(completed, ['resume', 'cancel-before-release', 'unmount-after-defer'], 'All three isolated root-modal outcomes are required');
  console.log('PASS: all three isolated root-modal outcomes and navigation suite after its fresh app load.');
}
