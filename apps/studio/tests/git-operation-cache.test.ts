import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import git from 'isomorphic-git';
import { NativeGitEngine } from '../platform/git-engine.js';
import type { WorkspaceFiles } from '../platform/filesystem.js';
import { GitWorkspaceRepository } from '../server/git-workspace.js';
import { nodeReviewSource, nodeWorkspaceReviews } from '../server/review-store.js';
import type { WorkspaceControl } from '../shared/workspace.js';

// Like the existing Git integration fixtures, use disposable repositories and
// real packed objects. Never contact a provider or inspect a user's checkout.
for (const backend of ['native', 'server'] as const) {
  test(`${backend} status reuses packs only within one calculation and observes later mutations`, async t => {
    const base = await fs.promises.mkdtemp(join(tmpdir(), 'studio-git-cache-'));
    t.after(() => fs.promises.rm(base, { recursive: true, force: true }));
    const root = join(base, 'workspace');
    await fs.promises.mkdir(root);
    const run = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();
    run(['init', '-b', 'main']);
    run(['config', 'user.name', 'Cache Test']);
    run(['config', 'user.email', 'cache@example.com']);
    const url = 'https://git.test/cache.git';
    run(['remote', 'add', 'origin', url]);
    const article = 'content/articles/first/index.md';
    await fs.promises.mkdir(join(root, 'content/articles/first'), { recursive: true });
    for (let index = 0; index < 3; index++) {
      await fs.promises.writeFile(join(root, article), `Article version ${index}\n`);
      run(['add', article]);
      run(['commit', '-m', `version ${index}`]);
      if (index === 0) run(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    }
    run(['repack', '-ad']);
    run(['prune-packed']);
    const packDirectory = join(root, '.git/objects/pack');
    const packNames = await fs.promises.readdir(packDirectory);
    assert.equal(packNames.filter(name => name.endsWith('.pack')).length, 1);

    const reads = new Map<string, number>();
    const originalReadFile = fs.promises.readFile;
    t.mock.method(fs.promises, 'readFile', (...args: Parameters<typeof originalReadFile>) => {
      const path = String(args[0]).replaceAll('\\', '/');
      if (/\/objects\/pack\/[^/]+\.(pack|idx)$/.test(path)) reads.set(path, (reads.get(path) ?? 0) + 1);
      return originalReadFile(...args);
    });
    const files: WorkspaceFiles = {
      readFile: (path, options) => (options === 'utf8' || typeof options === 'object' && options !== null && 'encoding' in options)
        ? fs.promises.readFile(path, 'utf8') : fs.promises.readFile(path),
      writeFile: async (path, bytes) => { await fs.promises.writeFile(path, bytes); },
      readdir: path => fs.promises.readdir(path),
      mkdir: async (path, options) => { await fs.promises.mkdir(path, options); },
      rmdir: path => fs.promises.rmdir(path), unlink: path => fs.promises.unlink(path),
      rename: (from, to) => fs.promises.rename(from, to),
      stat: path => fs.promises.stat(path), lstat: path => fs.promises.lstat(path),
      readlink: path => fs.promises.readlink(path), symlink: (target, path) => fs.promises.symlink(target, path),
      chmod: (path, mode) => fs.promises.chmod(path, mode),
    };
    const workspace: WorkspaceControl = backend === 'native'
      ? new NativeGitEngine(files, root, join(base, 'state'), {
        id: crypto.randomUUID(), label: 'Cache Test', provider: 'generic', source: 'local', localPath: root,
        url, branch: 'main', username: '', authorName: 'Cache Test', authorEmail: 'cache@example.com',
      }, { request: async () => { throw new Error('Unexpected network request'); } }, () => ({ username: '', password: '' }),
      { store: nodeWorkspaceReviews(root), source: nodeReviewSource(root) })
      : new GitWorkspaceRepository({ directory: root, url, branch: 'main', username: '', token: '',
        name: 'Cache Test', email: 'cache@example.com' }).workspace;

    // Reproduce the previous separate-cache sequence as a measured call-count
    // baseline. This is not a CPU benchmark and does not count content hashes.
    const localHistory = await git.log({ fs, dir: root, ref: 'HEAD' });
    const remoteHistory = await git.log({ fs, dir: root, ref: 'refs/remotes/origin/main' });
    await git.statusMatrix({ fs, dir: root, refresh: false });
    assert.equal(reads.size, 2, 'one pack and one pack index are used');
    assert.deepEqual([...reads.values()], [3, 3], 'separate calls each reload the same pack/index');
    reads.clear();
    const first = await workspace.status();
    assert.equal(first.ahead, localHistory.length - remoteHistory.length);
    assert.equal(first.behind, 0);
    assert.equal(first.dirty, false);
    assert.equal(reads.size, 2);
    assert.deepEqual([...reads.values()], [1, 1], 'logs and matrix share a single pack/index load');
    reads.clear();
    assert.deepEqual(await workspace.status(), first);
    assert.equal(reads.size, 2);
    assert.deepEqual([...reads.values()], [1, 1], 'a new operation reloads instead of retaining the previous cache');

    assert.equal(first.confirmation, undefined);
    assert.equal(first.confirmationExpiresAt, undefined);
    await assert.rejects(fs.promises.stat(root + '.studio-reviews-v1'), { code: 'ENOENT' }, 'status polling must not capture even an empty review');
    const firstReview = await workspace.createReview();
    assert.ok(firstReview.confirmation);
    const manifestPath = join(root + '.studio-reviews-v1', 'manifest.json');
    const manifestBeforePolling = await originalReadFile(manifestPath);

    await fs.promises.writeFile(join(root, article), 'Uncommitted writing with a different length\n');
    const changed = await workspace.status();
    assert.equal(changed.dirty, true);
    assert.deepEqual(changed.managedChanges, [article]);
    assert.equal(changed.confirmation, undefined);
    assert.deepEqual(await originalReadFile(manifestPath), manifestBeforePolling, 'changed ordinary status must not capture a replacement snapshot');
    await assert.rejects(workspace.commit('stale preview', firstReview.confirmation), /重新确认/);

    // The same instance must see an externally replaced index, and must not
    // silently include an unrelated staged file in a content commit.
    await fs.promises.writeFile(join(root, 'unrelated.ts'), 'export {};\n');
    run(['add', 'unrelated.ts']);
    await assert.rejects(workspace.commit('content only'), /暂存区/);
    run(['reset', 'HEAD', '--', 'unrelated.ts']);
    await fs.promises.unlink(join(root, 'unrelated.ts'));
    const [reviewed, concurrentReview] = await Promise.all([workspace.createReview(), workspace.createReview()]);
    assert.ok(reviewed.confirmation);
    assert.equal(concurrentReview.confirmation, reviewed.confirmation, 'the workspace lock serializes identical explicit reviews');
    assert.notEqual(reviewed.confirmation, firstReview.confirmation);
    const reviewedText = await originalReadFile(join(root, article), 'utf8');
    await fs.promises.writeFile(join(root, article), reviewedText.replace('Uncommitted', 'uncommitted'));
    await assert.rejects(workspace.commit('same flags, different bytes', reviewed.confirmation), /重新确认/);
    assert.equal(run(['rev-parse', 'HEAD']), first.head);
    await fs.promises.writeFile(join(root, article), reviewedText);
    const committed = await workspace.commit('content update', reviewed.confirmation);
    assert.equal(committed.confirmation, undefined);
    assert.equal(committed.confirmationExpiresAt, undefined);
    assert.equal(committed.dirty, false, 'post-commit status uses a fresh index and HEAD');
    assert.equal(committed.ahead, 3);
    assert.notEqual(committed.head, first.head);
    assert.equal(run(['show', `HEAD:${article}`]), 'Uncommitted writing with a different length');

    await fs.promises.unlink(join(root, article));
    const deletion = await workspace.createReview();
    assert.ok(deletion.confirmation);
    assert.deepEqual(deletion.managedChanges, [article]);
    const removed = await workspace.commit('remove article', deletion.confirmation);
    assert.equal(removed.dirty, false, 'remove/commit cannot reuse the pre-mutation matrix index');
    assert.equal(removed.ahead, 4);
    assert.equal(run(['ls-files', article]), '');

    // A previously verified pack must be verified again on the next operation.
    // A failed status must also release its cache so restoring bytes can recover.
    const packPath = join(packDirectory, packNames.find(name => name.endsWith('.pack'))!);
    const bytes = await originalReadFile(packPath);
    const damaged = Buffer.from(bytes);
    damaged[damaged.length - 1] ^= 1;
    // Git creates read-only packs. Only make this disposable fixture writable,
    // and restore both its bytes and permissions even if the assertion fails.
    const packMode = (await fs.promises.stat(packPath)).mode & 0o777;
    await fs.promises.chmod(packPath, packMode | 0o200);
    try {
      await fs.promises.writeFile(packPath, damaged);
      await assert.rejects(workspace.status(), /[Pp]ackfile/);
    } finally {
      try { await fs.promises.writeFile(packPath, bytes); }
      finally { await fs.promises.chmod(packPath, packMode); }
    }
    assert.deepEqual(await workspace.status(), removed);

    // Exercise the actual engine review -> commit path, not just the store, at the
    // allowed per-image size and with a multi-file payload above the old RAM cap.
    const media = ['public/uploads/large-a.png', 'public/uploads/large-b.png'];
    const mediaBytes = 20 * 1024 * 1024;
    await fs.promises.mkdir(join(root, 'public/uploads'), { recursive: true });
    const chunk = Buffer.alloc(64 * 1024, 173);
    // A complete tiny PNG followed by padding exercises the allowed media size
    // without requiring a large decoded image or a full-payload fixture buffer.
    const pngHeader = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNwinr/HwAE+AKLJh4rzQAAAABJRU5ErkJggg==', 'base64');
    for (const path of media) {
      const handle = await fs.promises.open(join(root, path), 'wx');
      try {
        for (let offset = 0; offset < mediaBytes;) {
          const { bytesWritten } = await handle.write(chunk, 0, Math.min(chunk.length, mediaBytes - offset), offset);
          assert.ok(bytesWritten > 0); offset += bytesWritten;
        }
        await handle.write(pngHeader, 0, pngHeader.length, 0);
      } finally { await handle.close(); }
    }
    const beforeMediaReview = await originalReadFile(manifestPath);
    const mediaStatus = await workspace.status();
    assert.deepEqual(mediaStatus.managedChanges, media);
    assert.equal(mediaStatus.confirmation, undefined);
    assert.deepEqual(await originalReadFile(manifestPath), beforeMediaReview, 'large media polling must not capture payloads');
    const mediaReview = await workspace.createReview();
    assert.ok(mediaReview.confirmation);
    assert.deepEqual(mediaReview.managedChanges, media);
    const mediaCommit = await workspace.commit('media: reviewed large files', mediaReview.confirmation);
    assert.equal(mediaCommit.dirty, false);
    assert.equal(mediaCommit.confirmation, undefined);
    for (const path of media) assert.equal(Number(run(['cat-file', '-s', `HEAD:${path}`])), mediaBytes);
    assert.deepEqual(run(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).split('\n'), media);
    assert.equal(run(['ls-files']).includes('studio-reviews'), false, 'review storage must remain outside the Git tree');
  });
}
