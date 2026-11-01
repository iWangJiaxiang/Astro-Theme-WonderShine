import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';

// Run the real browser build with Tauri-shaped stats and a filesystem RPC bridge.
// Node hosts the temporary files only; content/Git operations execute in Chromium.
const studio = fileURLToPath(new URL('../../', import.meta.url));
const base = await fs.mkdtemp(join(tmpdir(), 'studio-native-browser-'));
const root = join(base, 'workspace'), stateRoot = join(base, 'state');
let browser, server;
try {
  await fs.mkdir(root);
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();
  git(['init', '-b', 'main']);
  await fs.mkdir(join(root, 'content/articles/example'), { recursive: true });
  await fs.writeFile(join(root, 'config.toml'), 'title="Native browser fixture"\nbase_url="https://example.com"\ndefault_language="zh-CN"\ntaxonomies=[{name="tags"},{name="categories"}]\n[languages.en]\ntaxonomies=[{name="tags"},{name="categories"}]\n');
  await fs.writeFile(join(root, 'data.toml'), '');
  await fs.writeFile(join(root, 'content/articles/example/index.md'), '+++\ntitle="Example"\ndraft=true\ndate="2026-10-31"\n+++\nInitial text.\n');
  git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'initial']);
  const originalHead = git(['rev-parse', 'HEAD']);
  git(['remote', 'add', 'origin', 'https://git.example.test/fixture.git']);
  git(['update-ref', 'refs/remotes/origin/main', originalHead]);
  const source = `
    import { NativeGitEngine } from './platform/git-engine.ts';
    import { FileRepository } from './platform/file-repository.ts';
    import { nativeFileInfo } from './platform/tauri-filesystem.ts';
    import { createContentTransport } from './core/transport.ts';
    import { ContentService } from './core/content-service.ts';
    async function call(method, path, ...args) {
      const result = await window.nativeFiles({ method, path, args });
      if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      return result.value;
    }
    async function stat(method, path) {
      const value = await call(method, path);
      return nativeFileInfo({ ...value, mtime: value.mtime ? new Date(value.mtime) : null, birthtime: value.birthtime ? new Date(value.birthtime) : null });
    }
    const files = {
      readFile: async (path, options) => {
        const bytes = new Uint8Array(await call('readFile', path));
        return options === 'utf8' || options && typeof options === 'object' && 'encoding' in options ? new TextDecoder().decode(bytes) : bytes;
      },
      writeFile: (path, bytes) => call('writeFile', path, typeof bytes === 'string' ? { text: bytes } : { bytes: Array.from(bytes) }),
      readdir: path => call('readdir', path), mkdir: (path, options) => call('mkdir', path, options),
      rmdir: path => call('rmdir', path), unlink: path => call('unlink', path),
      rename: (from, to) => call('rename', from, to),
      stat: path => stat('stat', path), lstat: path => stat('lstat', path),
      readlink: async () => { throw new Error('Symlinks are unsupported in native workspaces'); },
      symlink: async () => { throw new Error('Symlinks are unsupported in native workspaces'); },
      chmod: async () => {},
    };
    let engine, transport, service;
    export async function connect(root, stateRoot) {
      const profile = { id: 'f6347560-bbe9-4c35-9d89-b0429108882b', label: 'Native browser', provider: 'generic',
        url: 'https://git.example.test/fixture.git', branch: 'main', username: 'fixture', authorName: 'Browser author', authorEmail: 'browser@example.com' };
      const noNetwork = { request: async () => { throw new Error('Test is offline; no Git HTTP requests are allowed'); } };
      engine = new NativeGitEngine(files, root, stateRoot, profile, noNetwork, () => ({ username: 'fixture', password: '' }));
      await engine.open();
      const local = new FileRepository(files, root, stateRoot, () => engine.assertWritable());
      await local.recover();
      const repository = { mode: 'git', workspace: engine,
        read: local.read.bind(local), list: local.list.bind(local), readMedia: local.readMedia.bind(local),
        listMedia: local.listMedia.bind(local), uploadMedia: local.uploadMedia.bind(local),
        write: local.write.bind(local), writeBatch: local.writeBatch.bind(local) };
      transport = createContentTransport(repository, { identity: { id: profile.id, name: 'Browser author' } });
      service = new ContentService(repository);
      return engine.status();
    }
    export async function request(path, method = 'GET', body) {
      const response = await transport(new Request(location.origin + '/api' + path, { method,
        headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
      return { status: response.status, data: await response.json() };
    }
    export const languages = () => service.languages();
    export const status = () => engine.status();
    export const commit = message => engine.commit(message);
  `;
  const bundle = await build({ stdin: { contents: source, resolveDir: studio, sourcefile: 'native-smoke-entry.js' }, bundle: true,
    platform: 'browser', format: 'esm', target: 'es2022', write: false });
  server = createServer((request, response) => {
    if (request.url === '/native-entry.js') { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(bundle.outputFiles[0].contents); }
    else if (request.url === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><html><head><meta charset="utf-8"><title>Native runtime regression</title></head><body>Native runtime regression</body></html>'); }
    else response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.STUDIO_TEST_BROWSER || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
  if (!executablePath) throw new Error('Set STUDIO_TEST_BROWSER to an installed Chromium executable.');
  browser = await puppeteer.launch({ headless: true, executablePath });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', request => request.url().startsWith(origin + '/') ? request.continue() : request.abort());
  function confined(path) {
    const normalized = resolve(path);
    if (normalized !== base && !normalized.startsWith(base + sep)) throw new Error('Fixture filesystem request escaped its temporary directory');
    return normalized;
  }
  await page.exposeFunction('nativeFiles', async ({ method, path, args }) => {
    try {
      path = confined(path);
      let value;
      switch (method) {
        case 'readFile': value = [...await fs.readFile(path)]; break;
        case 'writeFile': await fs.writeFile(path, args[0].text ?? new Uint8Array(args[0].bytes)); break;
        case 'readdir': value = await fs.readdir(path); break;
        case 'mkdir': await fs.mkdir(path, args[0]); break;
        case 'rmdir': await fs.rmdir(path); break;
        case 'unlink': await fs.unlink(path); break;
        case 'rename': await fs.rename(path, confined(args[0])); break;
        case 'stat': case 'lstat': {
          const info = await fs[method](path);
          // Match native/plugin-fs, including optional Unix fields unavailable on mobile.
          value = { size: info.size, mtime: info.mtime.toISOString(), birthtime: info.birthtime.toISOString(),
            isFile: info.isFile(), isDirectory: info.isDirectory(), isSymlink: info.isSymbolicLink(),
            mode: null, dev: null, ino: null, uid: null, gid: null };
          break;
        }
        default: throw new Error('Unknown fixture filesystem operation');
      }
      return { value };
    } catch (error) { return { error: { message: error.message, code: error.code || 'EIO' } }; }
  });
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.evaluate(() => typeof globalThis.Buffer), 'undefined', 'the browser starts without Node Buffer');
  await page.evaluate(async () => { window.native = await import('/native-entry.js'); });
  assert.equal(await page.evaluate(() => typeof globalThis.Buffer), 'function', 'native Git installs its explicit byte-array shim');
  const initial = await page.evaluate((root, stateRoot) => window.native.connect(root, stateRoot), root, stateRoot);
  assert.equal(initial.dirty, false); assert.equal(initial.head, originalHead);
  assert.deepEqual(await page.evaluate(() => window.native.languages()), { defaultLanguage: 'zh-CN', languages: ['zh-CN', 'en'] });
  const current = await page.evaluate(() => window.native.request('/document?path=content/articles/example/index.md'));
  assert.equal(current.status, 200);
  const saved = await page.evaluate(revision => window.native.request('/document', 'PUT', {
    path: 'content/articles/example/index.md', revision, changes: { title: '离线写作验证', draft: true }, body: '# Browser-native writing\n\n离线正文。\n',
  }), current.data.revision);
  assert.equal(saved.status, 200, JSON.stringify(saved));
  assert.match(await fs.readFile(join(root, 'content/articles/example/index.md'), 'utf8'), /Browser-native writing/);
  const settings = await page.evaluate(() => window.native.request('/settings/taxonomies?language=en'));
  assert.equal(settings.status, 200, JSON.stringify(settings));
  const localized = await page.evaluate(revision => window.native.request('/settings/taxonomies?language=en', 'PUT', { revision, changes: { 'post.tags': [{ id: 'writing', name: 'Writing' }] } }), settings.data.revision);
  assert.equal(localized.status, 200, JSON.stringify(localized));
  const translated = await page.evaluate(revision => window.native.request('/translation/manual', 'POST', {
    path: 'content/articles/example/index.md', revision, language: 'en',
  }), saved.data.revision);
  assert.equal(translated.status, 201, JSON.stringify(translated));
  const dirty = await page.evaluate(() => window.native.status());
  assert.equal(dirty.dirty, true);
  const commit = await page.evaluate(() => window.native.commit('docs(content): browser offline writing'));
  assert.equal(commit.dirty, false); assert.equal(commit.ahead, 1); assert.notEqual(commit.head, originalHead);
  assert.equal(git(['rev-parse', 'HEAD']), commit.head);
  assert.equal(git(['log', '-1', '--format=%an']), 'Browser author');
  assert.doesNotMatch(git(['ls-tree', '-r', '--name-only', 'HEAD']), /history-|transaction\.json|sync\.json/);
  assert.equal((await page.evaluate((root, stateRoot) => window.native.connect(root, stateRoot), root, stateRoot)).head, commit.head, 'reopen retains offline commits');
  const stale = await page.evaluate(revision => window.native.request('/document', 'PUT', {
    path: 'content/articles/example/index.md', revision, changes: { title: 'stale overwrite' }, body: 'unsafe',
  }), current.data.revision);
  assert.equal(stale.status, 409);
  assert.deepEqual(errors, []);
  console.log('Native browser runtime passed: Buffer-free startup, native stat adapter, offline open/save/translation/commit/reopen, stale-write protection.');
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await fs.rm(base, { recursive: true, force: true });
}
