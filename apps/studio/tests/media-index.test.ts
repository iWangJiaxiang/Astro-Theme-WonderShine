import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileRepository } from '../platform/file-repository';
import type { WorkspaceFiles } from '../platform/filesystem';
import { createNativeMediaIndex } from '../platform/media-index';
import type { WorkspaceControl } from '../shared/workspace';

test('managed media lists survive reopening, keep uncommitted uploads and invalidate before checkout', async t => {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'studio-media-index-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = join(base, 'repo'), state = join(base, 'state');
  await fs.mkdir(join(root, 'public/img'), { recursive: true });
  await fs.mkdir(state);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aIFYAAAAASUVORK5CYII=', 'base64');
  await fs.writeFile(join(root, 'public/img/first.png'), png);
  const files = fs as unknown as WorkspaceFiles;
  let scans = 0;
  const repository = new FileRepository(files, root, state);
  const scan = repository.listMedia.bind(repository);
  repository.listMedia = () => { scans++; return scan(); };
  const syncError = new Error('Checkout interrupted');
  Object.assign(repository, { workspace: {
    async sync() {
      await fs.unlink(join(root, 'public/img/first.png'));
      throw syncError;
    },
  } as unknown as WorkspaceControl });
  const open = (scope = 'workspace-one', managed = true) => createNativeMediaIndex(repository, files, state, base, scope, managed);

  const initial = open();
  assert.equal((await initial.repository.listMedia()).items.length, 1);
  initial.dispose();
  const reopened = open();
  assert.equal((await reopened.repository.listMedia()).items.length, 1);
  assert.equal(scans, 1);
  const saved = await reopened.repository.uploadMedia('public/img', 'new.png', png);
  reopened.dispose();

  const afterUpload = open();
  assert.ok((await afterUpload.repository.listMedia()).items.some(item => item.path === saved.item.path));
  assert.equal(scans, 1);
  await assert.rejects(afterUpload.repository.workspace!.sync(), error => error === syncError);
  afterUpload.dispose();
  const afterSync = open();
  assert.deepEqual((await afterSync.repository.listMedia()).items.map(item => item.path), [saved.item.path]);
  assert.equal(scans, 2);
  afterSync.dispose();

  const external = open('workspace-one', false);
  assert.deepEqual((await external.preview())?.items.map(item => item.path), [saved.item.path]);
  await fs.writeFile(join(root, 'public/img/external.png'), png);
  assert.equal((await external.repository.listMedia()).items.length, 2);
  assert.equal(scans, 3);
  external.dispose();

  const other = open('workspace-two');
  assert.equal(await other.preview(), null);
  await other.repository.listMedia();
  await other.repository.listMedia(true);
  other.dispose();
  const afterRefresh = open('workspace-two');
  assert.equal((await afterRefresh.repository.listMedia()).items.length, 2);
  assert.equal(scans, 5);
  afterRefresh.dispose();
});
