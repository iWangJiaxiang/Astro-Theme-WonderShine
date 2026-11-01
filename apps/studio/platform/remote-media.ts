/** Read native response streams without buffering an unlimited media download. */
export async function readRemoteMedia(response: Response, limit: number, signal: AbortSignal): Promise<Blob | null> {
  if (!response.ok || Number(response.headers.get('content-length')) > limit || signal.aborted) {
    await response.body?.cancel().catch(() => {});
    signal.throwIfAborted();
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(new Uint8Array(value));
    }
    return new Blob(chunks, { type: response.headers.get('content-type') || 'application/octet-stream' });
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
