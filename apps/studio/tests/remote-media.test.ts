import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readRemoteMedia } from '../platform/remote-media';

test('remote images preserve their bytes and MIME type up to the size limit', async () => {
  const response = new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
  const blob = await readRemoteMedia(response, 3, new AbortController().signal);
  assert.equal(blob?.type, 'image/png');
  assert.deepEqual(new Uint8Array(await blob!.arrayBuffer()), new Uint8Array([1, 2, 3]));
  assert.equal(response.body!.locked, false);
});

test('unusable and declared oversized responses are cancelled without reading their bodies', async () => {
  for (const init of [{ status: 404 }, { headers: { 'content-length': '21' } }]) {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), init);
    assert.equal(await readRemoteMedia(response, 20, new AbortController().signal), null);
    assert.equal(cancelled, true);
  }
});

test('missing or false Content-Length cannot bypass the streaming size limit', async () => {
  for (const headers of [undefined, { 'content-length': '1' }]) {
    let reads = 0, cancelled = false;
    const response = new Response(new ReadableStream({
      pull(controller) { reads++; controller.enqueue(new Uint8Array(4)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { headers });
    assert.equal(await readRemoteMedia(response, 6, new AbortController().signal), null);
    assert.equal(reads, 2); assert.equal(cancelled, true); assert.equal(response.body!.locked, false);
  }
});

test('refresh or disconnect cancels a pending image read and releases the reader', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const pending = readRemoteMedia(response, 20, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true); assert.equal(response.body!.locked, false);
});

test('already cancelled image loads are discarded before reading', async () => {
  const controller = new AbortController(); controller.abort();
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  await assert.rejects(readRemoteMedia(response, 20, controller.signal), { name: 'AbortError' });
  assert.equal(cancelled, true);
});

test('an interrupted response releases its reader and propagates the failure', async () => {
  const response = new Response(new ReadableStream({ pull(controller) { controller.error(new Error('Network interrupted')); } }));
  await assert.rejects(readRemoteMedia(response, 20, new AbortController().signal), /Network interrupted/);
  assert.equal(response.body!.locked, false);
});
