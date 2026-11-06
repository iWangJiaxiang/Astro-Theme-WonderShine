import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { StudioError } from '../core/errors.js';
import {
  createWorkspaceReviewStore, requireWorkspaceConfirmation, reviewChunkBytes,
  type ReviewReader, type ReviewSource, type ReviewState,
} from '../shared/workspace-confirmation.js';
import { nodeReviewDisk, nodeReviewSource } from '../server/review-store.js';

const state = (): ReviewState => ({ scope: 'node:/private/checkout', branch: 'main', head: 'head', rows: [['article.md', 1, 2, 1]] });
const status = (code: number) => (error: unknown) => error instanceof StudioError && error.status === code;
function bytesSource(bytes: Uint8Array, stride = Infinity): ReviewSource {
  return async () => {
    let offset = 0;
    return {
      async read(buffer) {
        assert.ok(buffer.length <= reviewChunkBytes);
        const count = Math.min(buffer.length, bytes.length - offset, stride);
        buffer.set(bytes.subarray(offset, offset + count)); offset += count;
        return count;
      },
      async close() {},
    };
  };
}
const textSource = (text: string) => bytesSource(new TextEncoder().encode(text));
async function fixture(context: { after(action: () => Promise<void>): void }) {
  const parent = await mkdtemp(join(tmpdir(), 'studio-review-'));
  context.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'checkout');
  await mkdir(root);
  return { root, parent, directory: root + '.studio-reviews-v1', disk: nodeReviewDisk(root) };
}

test('separate worker instances validate the same published exact-byte review', async context => {
  const { root, disk, directory } = await fixture(context);
  const first = createWorkspaceReviewStore(disk);
  const review = await first.createReview(state(), textSource('first edit'));
  const worker = createWorkspaceReviewStore(nodeReviewDisk(root));
  await worker.validateReview(review.confirmation, state(), textSource('first edit'));
  await assert.rejects(worker.validateReview(review.confirmation, state(), textSource('other edit')), status(409));
  assert.deepEqual(await worker.createReview(state(), textSource('first edit')), review);
  assert.deepEqual((await readdir(directory)).sort(), [review.confirmation + '.bin', 'manifest.json'].sort());
  assert.equal(review.confirmation.includes('private'), false);
  assert.equal(review.confirmation.includes('first edit'), false);
});

test('a child Node process validates a parent review without shared JS state', async context => {
  const { root, disk } = await fixture(context);
  await writeFile(join(root, 'article.md'), 'handoff');
  const review = await createWorkspaceReviewStore(disk).createReview(state(), nodeReviewSource(root));
  const moduleURL = new URL('../server/review-store.ts', import.meta.url).href;
  const script = `
    const { nodeWorkspaceReviews, nodeReviewSource } = await import(process.env.REVIEW_MODULE);
    await nodeWorkspaceReviews(process.env.REVIEW_ROOT).validateReview(
      process.env.REVIEW_TOKEN, JSON.parse(process.env.REVIEW_STATE), nodeReviewSource(process.env.REVIEW_ROOT));
    process.stdout.write('validated');
  `;
  const { stdout, stderr } = await promisify(execFile)(process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script], {
      env: { ...process.env, REVIEW_MODULE: moduleURL, REVIEW_ROOT: root,
        REVIEW_TOKEN: review.confirmation, REVIEW_STATE: JSON.stringify(state()) },
      timeout: 30_000,
    });
  assert.equal(stdout, 'validated');
  assert.equal(stderr, '');
});

test('branch HEAD index flags deletion membership and scope all invalidate', async context => {
  const { disk } = await fixture(context);
  const store = createWorkspaceReviewStore(disk);
  const review = await store.createReview(state(), textSource('same'));
  const variants: ReviewState[] = [
    { ...state(), branch: 'other' }, { ...state(), head: null }, { ...state(), head: 'other' },
    { ...state(), scope: 'node:/other' }, { ...state(), rows: [] },
    { ...state(), rows: [['article.md', 1, 2, 2]] }, { ...state(), rows: [['article.md', 1, 0, 1]] },
    { ...state(), rows: [['Article.md', 1, 2, 1]] },
  ];
  for (const variant of variants) await assert.rejects(store.validateReview(review.confirmation, variant, textSource('same')), status(409));
  const deleted = { ...state(), rows: [['article.md', 1, 0, 1]] as ReviewState['rows'] };
  const noRead: ReviewSource = async () => { throw new Error('Deleted paths must not be read'); };
  const deletion = await store.createReview(deleted, noRead);
  await store.validateReview(deletion.confirmation, deleted, noRead);
  await assert.rejects(store.validateReview(review.confirmation, state(), textSource('same')), status(409));
});

test('exact bytes reject binary changes, normalization, appended and truncated bytes', async context => {
  const { disk } = await fixture(context);
  const store = createWorkspaceReviewStore(disk);
  for (const [before, after] of [
    [new Uint8Array([128]), new Uint8Array([129])],
    [new TextEncoder().encode('é'), new TextEncoder().encode('e\u0301')],
    [new TextEncoder().encode('a\r\n'), new TextEncoder().encode('a\n')],
    [new Uint8Array([0, 1]), new Uint8Array([0])],
    [new Uint8Array(), new Uint8Array([0])],
  ]) {
    const review = await store.createReview(state(), bytesSource(before, 1));
    await store.validateReview(review.confirmation, state(), bytesSource(before, 1));
    await assert.rejects(store.validateReview(review.confirmation, state(), bytesSource(after, 1)), status(409));
  }
});

test('multiple allowed 20 MiB media files use bounded chunks without digests', async context => {
  const { disk } = await fixture(context);
  const digest = context.mock.method(crypto.subtle, 'digest', () => { throw new Error('Unexpected digest'); });
  const store = createWorkspaceReviewStore(disk);
  const large = { ...state(), rows: [['a.jpg', 0, 2, 0], ['b.jpg', 0, 2, 0]] as ReviewState['rows'] };
  let largest = 0;
  const generated: ReviewSource = async () => {
    let remaining = 20 * 1024 * 1024;
    return {
      async read(buffer) {
        largest = Math.max(largest, buffer.length);
        const count = Math.min(remaining, buffer.length);
        buffer.fill(173, 0, count); remaining -= count;
        return count;
      }, async close() {},
    };
  };
  const review = await store.createReview(large, generated);
  await store.validateReview(review.confirmation, large, generated);
  assert.equal(largest, reviewChunkBytes);
  assert.equal(digest.mock.callCount(), 0);
});

test('TTL is fixed, unknown tokens fail, validation never silently creates a review', async context => {
  const { disk, directory } = await fixture(context);
  let now = 0;
  const store = createWorkspaceReviewStore(disk, { ttlMs: 100, now: () => now });
  const review = await store.createReview(state(), textSource('same'));
  const original = await readFile(join(directory, 'manifest.json'));
  now = 99;
  assert.deepEqual(await store.createReview(state(), textSource('same')), review);
  now = 100;
  await assert.rejects(store.validateReview(review.confirmation, state(), textSource('same')), status(409));
  await assert.rejects(store.validateReview(crypto.randomUUID(), state(), textSource('same')), status(409));
  assert.deepEqual(await readFile(join(directory, 'manifest.json')), original);
  await store.cleanup();
  assert.deepEqual(await readdir(directory), []);
  assert.notEqual((await store.createReview(state(), textSource('same'))).confirmation, review.confirmation);
});

test('quota failure immediately removes unpublished files and preserves prior review', async context => {
  const { disk, directory, root } = await fixture(context);
  await writeFile(join(root, 'user.txt'), 'keep');
  const store = createWorkspaceReviewStore(disk, { maxSnapshotBytes: 8 });
  const review = await store.createReview(state(), textSource('small'));
  await assert.rejects(store.createReview(state(), textSource('too much private data')), (error: unknown) => {
    assert.ok(error instanceof StudioError);
    assert.equal(error.status, 413);
    assert.equal(error.message.includes('private data'), false);
    return true;
  });
  assert.deepEqual((await readdir(directory)).sort(), [review.confirmation + '.bin', 'manifest.json'].sort());
  await store.validateReview(review.confirmation, state(), textSource('small'));
  await store.cleanup();
  assert.equal((await readdir(directory)).length, 2);
  assert.equal(await readFile(join(root, 'user.txt'), 'utf8'), 'keep');
});

test('capture interruption and manifest publish failure never authorize partial data', async context => {
  const { disk, directory } = await fixture(context);
  const store = createWorkspaceReviewStore(disk);
  const review = await store.createReview(state(), textSource('before'));
  const failing = createWorkspaceReviewStore({ ...disk, async rename(from, to) {
    if (to === 'manifest.json') throw new Error('private filesystem path');
    await disk.rename(from, to);
  } });
  await assert.rejects(failing.createReview(state(), textSource('after')), (error: unknown) => {
    assert.ok(error instanceof StudioError);
    assert.equal(error.status, 503);
    assert.equal(error.message.includes('private filesystem path'), false);
    return true;
  });
  assert.deepEqual((await readdir(directory)).sort(), [review.confirmation + '.bin', 'manifest.json'].sort());
  await store.validateReview(review.confirmation, state(), textSource('before'));
  await store.cleanup();
});

test('total store budget includes the previous payload during replacement', async context => {
  const { disk, directory } = await fixture(context);
  const store = createWorkspaceReviewStore(disk, { maxSnapshotBytes: 100, maxStoreBytes: 4 * 1024 * 1024 + 10 });
  const review = await store.createReview(state(), textSource('123456'));
  await assert.rejects(store.createReview(state(), textSource('abcdef')), status(413));
  assert.deepEqual((await readdir(directory)).sort(), [review.confirmation + '.bin', 'manifest.json'].sort());
  await store.validateReview(review.confirmation, state(), textSource('123456'));
});

test('old-file cleanup failure cannot turn a successful publication into an error', async context => {
  const { disk } = await fixture(context);
  const first = await createWorkspaceReviewStore(disk).createReview(state(), textSource('before'));
  const store = createWorkspaceReviewStore({ ...disk, async remove(name) {
    if (name === first.confirmation + '.bin') throw new Error('cleanup failed');
    await disk.remove(name);
  } });
  const second = await store.createReview(state(), textSource('after'));
  await store.validateReview(second.confirmation, state(), textSource('after'));
  await assert.rejects(store.createReview(state(), textSource('third')), status(503), 'next allocation must clean retained orphans first');
});

test('best-effort cleanup and close failures do not mask the original capture error', async context => {
  const { disk } = await fixture(context);
  const original = new StudioError(413, 'quota failure');
  const store = createWorkspaceReviewStore({ ...disk, async remove() { throw new Error('cleanup failure'); } });
  await assert.rejects(store.createReview(state(), async () => ({
    async read() { throw original; }, async close() { throw new Error('close failure'); },
  })), error => error === original);
});

test('cross-worker store lock rejects overlap without stealing active or abandoned locks', async context => {
  const { root, disk, directory } = await fixture(context);
  await disk.withLock(async () => {
    await assert.rejects(createWorkspaceReviewStore(nodeReviewDisk(root)).createReview(state(), textSource('same')), status(423));
  });
  await mkdir(join(directory, 'lock'), { mode: 0o700 });
  await assert.rejects(createWorkspaceReviewStore(disk).cleanup(), status(423));
});

test('direct validation never lists old snapshots and sequential identical reviews reuse token', async context => {
  const { disk } = await fixture(context);
  const store = createWorkspaceReviewStore(disk);
  const review = await store.createReview(state(), textSource('same'));
  for (let index = 0; index < 4; index++) assert.deepEqual(await store.createReview(state(), textSource('same')), review);
  const direct = createWorkspaceReviewStore({ ...disk, async list() { throw new Error('Must not scan'); } });
  await direct.validateReview(review.confirmation, state(), textSource('same'));
});

test('source rejects symlinks and cleanup refuses unrecognized files', async context => {
  const { root, disk, directory } = await fixture(context);
  const store = createWorkspaceReviewStore(disk);
  await writeFile(join(root, 'article.md'), 'same');
  const review = await store.createReview(state(), nodeReviewSource(root));
  await rm(join(root, 'article.md'));
  await writeFile(join(root, 'other.md'), 'same');
  await symlink(join(root, 'other.md'), join(root, 'article.md'));
  await assert.rejects(store.validateReview(review.confirmation, state(), nodeReviewSource(root)), status(503));
  await writeFile(join(directory, 'unrecognized-user-data'), 'preserve');
  await assert.rejects(store.cleanup(), status(503));
  assert.equal(await readFile(join(directory, 'unrecognized-user-data'), 'utf8'), 'preserve');
});

test('readers close on failure and transport still rejects missing confirmation', async context => {
  const { disk } = await fixture(context);
  let closed = false;
  const source: ReviewSource = async (): Promise<ReviewReader> => ({
    async read() { throw new Error('sensitive path'); }, async close() { closed = true; },
  });
  await assert.rejects(createWorkspaceReviewStore(disk).createReview(state(), source), status(503));
  assert.equal(closed, true);
  for (const value of [undefined, null, false, '', '  ', {}]) assert.throws(() => requireWorkspaceConfirmation(value), status(400));
});
