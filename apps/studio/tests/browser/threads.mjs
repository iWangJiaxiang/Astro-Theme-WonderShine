import puppeteer from 'puppeteer-core';
import { chooser } from './controls.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm, cp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { patchToml, splitDocument } from '../../server/content.ts';
import { parse } from 'smol-toml';
import { hashPassword } from '../../server/password.ts';
const studio = fileURLToPath(new URL('../../', import.meta.url));
const theme = fileURLToPath(new URL('../../../../examples/demo/', import.meta.url));
const base = await mkdtemp(join(tmpdir(), 'studio-browser-'));
const screenshots = join(studio, 'test-results');
await mkdir(screenshots, { recursive: true });
await mkdir(base + '/site/public/data', { recursive: true });
for (const name of ['config.toml', 'data.toml', 'content']) await cp(join(theme, name), join(base, 'site', name), { recursive: true });
await cp(join(theme, 'public/data/friends.json'), base + '/site/public/data/friends.json');
await writeFile(base + '/site/config.toml', patchToml(await readFile(base + '/site/config.toml', 'utf8'), { default_language: 'zh', 'languages.en.generate_feeds': true }));
const reserve = createServer();
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const origin = `http://localhost:${port}`;
const server = spawn(process.execPath, ['dist/server.mjs'], { cwd: studio, env: { ...process.env,
  STUDIO_ORIGIN: origin, PORT: String(port), STUDIO_HOST: '127.0.0.1', STUDIO_SITE_ROOT: base + '/site',
  STUDIO_STATE: 'file', STUDIO_STATE_DIR: base + '/state', STUDIO_GIT_URL: '', STUDIO_OIDC_ISSUER: '',
  STUDIO_ADMIN_USER: 'owner', STUDIO_ADMIN_PASSWORD_HASH: await hashPassword('studio-browser-test-2026'), STUDIO_SESSION_SECRET: randomBytes(32).toString('hex') }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = ''; server.stderr.on('data', data => { logs += data; });
const executablePath = process.env.STUDIO_TEST_BROWSER || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
let browser;
try {
  if (!executablePath) throw new Error('Set STUDIO_TEST_BROWSER to an installed Chrome/Chromium executable.');
  for (let i = 0; i < 100; i++) { try { if ((await fetch(origin + '/api/auth/config')).ok) break; } catch {} if (i === 99) throw new Error('Server did not start: ' + logs); await new Promise(r => setTimeout(r, 100)); }
  browser = await puppeteer.launch({ headless: true, executablePath });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN'] }));
  const click = async text => {
    await page.waitForFunction(text => [...document.querySelectorAll('button')].some(button => button.innerText.trim() === text && !button.disabled), {}, text);
    await page.evaluate(text => [...document.querySelectorAll('button')].find(button => button.innerText.trim() === text && !button.disabled).click(), text);
  };
  const fill = (selector, value) => page.$eval(selector, (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  const saved = async () => {
    await page.waitForSelector('.notice.success');
    await page.waitForFunction(() => ![...document.querySelectorAll('button')].some(button => button.innerText.includes('正在保存')));
    assert.equal(await page.$('.notice.error'), null);
  };
  const path = () => page.$eval('.path-label', node => node.textContent);
  const metadata = async path => parse(splitDocument(await readFile(join(base, 'site', path), 'utf8')).header);
  const choose = chooser(page);
  await page.goto(origin, { waitUntil: 'networkidle0' });
  await page.type('[name=username]', 'owner'); await page.type('[name=password]', 'studio-browser-test-2026'); await click('进入创作中心');

  await click('话题管理'); await click('新建话题'); await page.waitForSelector('.markdown-source');
  const topicPath = await path(); assert.match(topicPath, /^content\/topics\/t_[a-f0-9]{32}\/index\.md$/);
  await fill('.title-field input', '长期写作'); await fill('.markdown-source', '这个话题收集文章与动态。');
  await click('保存草稿'); await saved();
  const initialTopic = await metadata(topicPath);
  assert.equal(initialTopic.extra.kind, 'topic'); assert.equal(initialTopic.layout, 'topic');
  assert.ok(initialTopic.date); assert.ok(initialTopic.updated); assert.equal(initialTopic.draft, true);
  assert.match(await page.$eval('.topic-timestamps', node => node.textContent), /资料更新时间/);
  await fill('.markdown-source', '更新介绍，创建时间保持不变。'); await click('保存草稿'); await saved();
  const editedTopic = await metadata(topicPath);
  assert.equal(String(editedTopic.date), String(initialTopic.date));
  assert.notEqual(String(editedTopic.updated), String(initialTopic.updated));
  await click('本地保存 · 可发布'); await saved(); assert.equal((await metadata(topicPath)).draft, false);
  await page.screenshot({ path: join(screenshots, 'topic-editor-desktop.png'), fullPage: true });
  await click('en · 创建译文草稿'); await page.waitForFunction(() => document.querySelector('.path-label')?.textContent.endsWith('index.en.md'));
  assert.equal(await page.$eval('.markdown-source', input => input.value), '更新介绍，创建时间保持不变。');
  await fill('.title-field input', 'Writing over time'); await fill('.markdown-source', 'An introduction to this topic.');
  await click('保存草稿'); await saved();
  const translatedTopic = await metadata(await path());
  assert.equal(translatedTopic.extra.id, initialTopic.extra.id); assert.equal(String(translatedTopic.date), String(initialTopic.date));
  assert.equal(translatedTopic.draft, true);

  await click('动态'); await click('发动态'); await page.waitForSelector('.markdown-source');
  assert.equal(await page.$('.title-field'), null, 'thread creation must not require a title');
  assert.equal(await page.evaluate(() => document.body.innerText.includes('继续写一条')), false, 'threads have no continuation controls');
  const threadPath = await path(); assert.match(threadPath, /^content\/threads\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/index\.md$/);
  await fill('.markdown-source', '记录一个独立的想法。'); await choose('extra.topics', initialTopic.extra.id);
  await click('保存草稿'); await saved();
  const thread = await metadata(threadPath);
  assert.equal(thread.draft, true); assert.equal(thread.extra.kind, 'thread');
  assert.deepEqual(thread.extra.topics, [initialTopic.extra.id]);
  assert.equal(thread.extra.thread_root, undefined); assert.equal(thread.extra.reply_to, undefined);
  await click('本地保存 · 可发布'); await saved(); assert.equal((await metadata(threadPath)).draft, false);
  await click('en · 创建译文草稿'); await page.waitForFunction(() => document.querySelector('.path-label')?.textContent.endsWith('index.en.md'));
  assert.equal(await page.$eval('.markdown-source', input => input.value), '记录一个独立的想法。');
  await fill('.markdown-source', 'An independent thought.'); await click('保存草稿'); await saved();
  const translated = await metadata(await path());
  assert.equal(translated.extra.id, thread.extra.id); assert.equal(String(translated.date), String(thread.date));
  assert.deepEqual(translated.extra.topics, [initialTopic.extra.id]); assert.equal(translated.draft, true);
  assert.match(await page.$eval('[data-field="extra.topics"]', node => node.textContent), /Writing over time.*草稿/s);
  await page.screenshot({ path: join(screenshots, 'threads-editor-desktop.png'), fullPage: true });

  await click('文章'); await click('新建文章');
  await fill('.modal input[placeholder="给它取个名字"]', '文章关联话题');
  await fill('.modal input[placeholder="my-first-story"]', 'topic-browser-test'); await click('进入编辑器');
  await page.waitForSelector('.markdown-source'); await fill('.markdown-source', '文章也可以关联同一个话题。');
  await choose('extra.topics', initialTopic.extra.id); await click('本地保存'); await saved();
  assert.deepEqual((await metadata(await path())).extra.topics, [initialTopic.extra.id]);
  await click('合集管理'); await page.waitForSelector('.content-library');
  assert.match(await page.$eval('.page-heading', node => node.textContent), /文章按系列整理，音乐按专辑整理/);
  assert.deepEqual(errors, []);
  console.log('Topics browser flow passed: topic create/edit/publish/translate; independent thread and article associations; thread translation.');
} finally {
  await browser?.close(); server.kill('SIGTERM'); await rm(base, { recursive: true, force: true });
}
