import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tauriFiles } from '../platform/tauri-filesystem';
import { FileRepository } from '../platform/file-repository';
import { StudioError } from '../core/errors';

// Exercise the actual plugin-fs JS boundary without installing a native runtime.
async function fixture(run: (value: {
  root: string; outside: string; calls: { command: string; path: string }[];
  files: ReturnType<typeof tauriFiles>; repo: FileRepository;
  before: (hook: (command: string, path: string) => Promise<void>) => void;
}) => Promise<void>, unknownTypes = false) {
  const base = await fs.mkdtemp(join(tmpdir(), 'studio-tauri-files-'));
  const root = base + '/repo', outside = base + '/outside';
  await fs.mkdir(root); await fs.mkdir(outside);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const calls: { command: string; path: string }[] = [];
  let before = async (_command: string, _path: string) => {};
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { __TAURI_INTERNALS__: {
    invoke: async (command: string, args: { path: string }) => {
      const path = args.path;
      calls.push({ command, path });
      await before(command, path);
      // The plugin remains the authority for desktop grants, independently of JS roots.
      if (path !== root && !path.startsWith(root + '/')) throw new Error('forbidden path: filesystem scope');
      if (command === 'plugin:fs|lstat' || command === 'plugin:fs|stat') {
        const value = await (command.endsWith('|lstat') ? fs.lstat(path) : fs.stat(path));
        return { size: value.size, isFile: value.isFile(), isDirectory: value.isDirectory(), isSymlink: value.isSymbolicLink(),
          mtime: value.mtimeMs, atime: value.atimeMs, birthtime: value.birthtimeMs,
          readonly: false, fileAttributes: null, mode: value.mode, dev: value.dev, ino: value.ino, nlink: value.nlink,
          uid: value.uid, gid: value.gid, rdev: value.rdev, blksize: value.blksize, blocks: value.blocks };
      }
      if (command === 'plugin:fs|read_file') return Array.from(await fs.readFile(path));
      if (command === 'plugin:fs|read_dir') return (await fs.readdir(path, { withFileTypes: true })).map(item => ({
        name: item.name, isFile: !unknownTypes && item.isFile(), isDirectory: !unknownTypes && item.isDirectory(), isSymlink: !unknownTypes && item.isSymbolicLink(),
      }));
      throw new Error('Unexpected filesystem command: ' + command);
    },
  } } });
  const files = tauriFiles(root);
  try { await run({ root, outside, calls, files, repo: new FileRepository(files, root, root + '/state'), before: hook => { before = hook; } }); }
  finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
    await fs.rm(base, { recursive: true, force: true });
  }
}
const path = 'content/articles/hello/index.md';
async function article(root: string) {
  await fs.mkdir(root + '/content/articles/hello', { recursive: true });
  await fs.writeFile(root + '/' + path, 'hello');
}

test('checked content reads need one fresh path traversal and one read, not repeated stat passes', async () => fixture(async ({ root, calls, repo, files }) => {
  await article(root);
  const snapshot = await repo.read(path);
  assert.equal(snapshot?.text, 'hello');
  assert.equal(snapshot?.revision, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  assert.deepEqual(calls.map(call => call.command), [...Array(5).fill('plugin:fs|lstat'), 'plugin:fs|read_file']);
  calls.length = 0;
  assert.equal((await files.stat(root + '/' + path)).size, 5);
  assert.equal(calls.length, 5, 'stat reuses only its own fresh leaf metadata');
  assert.ok(calls.every(call => call.command === 'plugin:fs|lstat'));
  calls.length = 0;
  const fallback = new FileRepository({ ...files, readCheckedFile: undefined }, root, root + '/state');
  assert.deepEqual(await fallback.read(path), snapshot);
  assert.equal(calls.length, 15, 'fallback still performs repository checks; old native stat added a 16th call');
}));

test('native directory metadata avoids per-entry lstat, preserves ordering and excludes symlinks', async () => fixture(async ({ root, calls, repo }) => {
  await article(root);
  await fs.writeFile(root + '/content/articles/z.md', 'last');
  await fs.writeFile(root + '/content/articles/a.md', 'first');
  await fs.writeFile(root + '/content/articles/ignored.txt', 'ignore');
  await fs.symlink(root + '/content/articles/hello', root + '/content/articles/link');
  const summaries = await repo.listForSummary();
  assert.deepEqual(summaries.map(file => file.path), ['content/articles/a.md', path, 'content/articles/z.md']);
  assert.ok(summaries.every(file => !('revision' in file)));
  assert.equal(calls.filter(call => call.path.endsWith('/ignored.txt') || call.path.endsWith('/link')).length, 0);
  assert.equal(calls.filter(call => call.path === root + '/' + path && call.command.endsWith('|lstat')).length, 1,
    'discovery does not separately lstat a file that the checked read will inspect');
  assert.equal(calls.filter(call => call.command.endsWith('|stat')).length, 0);
}));

test('unknown directory entry types fall back to lstat without hiding files or I/O errors', async () => fixture(async ({ root, repo, before }) => {
  await article(root);
  assert.deepEqual((await repo.listForSummary()).map(file => file.path), [path]);
  before(async (command, file) => {
    if (command === 'plugin:fs|lstat' && file === root + '/content/articles/hello') throw new Error('permission denied');
  });
  await assert.rejects(repo.listForSummary(), /permission denied/);
}, true));

test('checked reads retain limits, file type, missing-file and fatal UTF-8 behavior', async () => fixture(async ({ root, repo, files, calls, before }) => {
  await article(root);
  await assert.rejects(files.readCheckedFile!(root + '/' + path, 4), error => error instanceof StudioError && error.status === 413);
  assert.equal(calls.filter(call => call.command.endsWith('|read_file')).length, 0, 'oversized metadata rejects before allocating file bytes');
  await assert.rejects(files.readCheckedFile!(root + '/content/articles/hello', 1024), error => error instanceof StudioError && error.status === 400);
  assert.equal(await repo.read('content/articles/missing.md'), null);
  before(async (command, file) => { if (command === 'plugin:fs|read_file') await fs.writeFile(file, 'grown'); });
  await fs.writeFile(root + '/' + path, 'x');
  await assert.rejects(files.readCheckedFile!(root + '/' + path, 2), error => error instanceof StudioError && error.status === 413);
  before(async () => {});
  await fs.writeFile(root + '/' + path, new Uint8Array([0xff]));
  await assert.rejects(repo.listForSummary(), /encoded data|encoding/i);
}));

test('fresh checks reject changed leaf, parent and root symlinks without trusting earlier metadata', async () => fixture(async ({ root, outside, files, repo }) => {
  await article(root);
  await fs.writeFile(outside + '/secret.md', 'private');
  await repo.listForSummary();
  await fs.unlink(root + '/' + path); await fs.symlink(outside + '/secret.md', root + '/' + path);
  await assert.rejects(repo.read(path), error => error instanceof StudioError && error.status === 400 && /符号链接/.test(error.message));
  await fs.unlink(root + '/' + path); await fs.writeFile(root + '/' + path, 'safe');
  await fs.rename(root + '/content/articles/hello', root + '/content/articles/original');
  await fs.symlink(outside, root + '/content/articles/hello');
  await assert.rejects(files.readCheckedFile!(root + '/' + path, 1024), /符号链接/);
  await assert.rejects(files.readCheckedDirectory!(root + '/content/articles/hello'), error => error instanceof StudioError && error.status === 400);
  await assert.rejects(files.writeFile(root + '/' + path, 'unsafe'), /符号链接/);
  await fs.rename(root, root + '-original'); await fs.symlink(outside, root);
  await assert.rejects(files.readCheckedDirectory!(root), /符号链接/);
}));

test('directory metadata never authorizes a later read, and native grants still apply to additional roots', async () => fixture(async ({ root, outside, files, repo, calls, before }) => {
  await article(root); await fs.writeFile(outside + '/secret.md', 'private');
  let swapped = false;
  before(async (command, file) => {
    if (!swapped && command === 'plugin:fs|lstat' && file === root + '/' + path) {
      swapped = true; await fs.unlink(file); await fs.symlink(outside + '/secret.md', file);
    }
  });
  await assert.rejects(repo.listForSummary(), /符号链接/);
  assert.ok(swapped);
  assert.equal(calls.filter(call => call.command === 'plugin:fs|read_file').length, 0);
  calls.length = 0;
  for (const invalid of [outside + '/secret.md', root + '-other/a', root + '/../outside/secret.md', root + '/a\0b']) {
    await assert.rejects(files.readCheckedFile!(invalid, 1024), /超出工作区/);
  }
  assert.equal(calls.length, 0, 'invalid paths never reach IPC');
  const desktop = tauriFiles(root, [outside]);
  await assert.rejects(desktop.readCheckedFile!(outside + '/secret.md', 1024), /filesystem scope/);
}));
