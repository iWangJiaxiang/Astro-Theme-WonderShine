import type { HttpClient, ProgressCallback } from 'isomorphic-git';
import type { WorkspaceFiles } from './filesystem';
import { NativeGitEngine } from './git-engine';
import { failure, restoreError, type DeviceIO, type JobRequest } from './mobile-git-protocol';

const worker = self as unknown as { postMessage(value: unknown, transfer?: Transferable[]): void; onmessage: ((event: MessageEvent<JobRequest>) => void) | null };
// Reserve slots before waking waiters, including after a failed filesystem operation.
let active = 0;
const waiting: Array<() => void> = [];
async function call<K extends keyof DeviceIO>(method: K, ...args: Parameters<DeviceIO[K]>): Promise<Awaited<ReturnType<DeviceIO[K]>>> {
  if (active >= 8) await new Promise<void>(resolve => waiting.push(resolve));
  else active++;
  const { port1, port2 } = new MessageChannel();
  try {
    return await new Promise<Awaited<ReturnType<DeviceIO[K]>>>((resolve, reject) => {
      port1.onmessage = ({ data }) => data.error ? reject(restoreError(data.error)) : resolve(data.value);
      port1.onmessageerror = () => reject(new Error('操作失败'));
      const transfer: Transferable[] = [port2];
      // Only the HTTP body is freshly assembled for this request. Git can reuse its file buffers.
      if (method === 'request' && args[1] instanceof Uint8Array && args[1].buffer instanceof ArrayBuffer) transfer.push(args[1].buffer);
      worker.postMessage({ kind: 'io', method, args }, transfer);
    });
  } finally {
    port1.close();
    const next = waiting.shift();
    if (next) next(); else active--;
  }
}
const stat = async (path: string, link: boolean) => {
  const info = await call('stat', path, link);
  return { ...info, isFile: () => info.file, isDirectory: () => info.directory, isSymbolicLink: () => info.symlink };
};
const files: WorkspaceFiles = {
  readFile: (...args) => call('readFile', ...args), writeFile: (...args) => call('writeFile', ...args),
  readdir: path => call('readdir', path), mkdir: (...args) => call('mkdir', ...args), rmdir: path => call('rmdir', path),
  unlink: path => call('unlink', path), rename: (...args) => call('rename', ...args), chmod: (...args) => call('chmod', ...args),
  stat: path => stat(path, false), lstat: path => stat(path, true),
  readlink: async () => { throw new Error('工作区不支持符号链接'); },
  symlink: async () => { throw new Error('工作区不支持符号链接'); },
};
const http: HttpClient = { async request({ url, method, headers, body }) {
  let bytes: Uint8Array | undefined;
  if (body) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) chunks.push(chunk);
    bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  }
  const { id, ...response } = await call('request', { url, method, headers }, bytes);
  return { ...response, body: (async function* () {
    try {
      for (;;) {
        const chunk = await call('readBody', id);
        if (chunk === null) return;
        yield chunk;
      }
    } finally { await call('closeBody', id); }
  })() };
} };

worker.onmessage = async ({ data: { job, root, state, profile, password } }) => {
  try {
    const git = new NativeGitEngine(files, root, state, profile, http, () => ({ username: profile.username || 'oauth2', password }), {
      // The native process owner and its checked source handles stay in the WebView.
      source: async () => { throw new Error('操作失败'); },
      store: { createReview: state => call('review', state), validateReview: (token, state) => call('validate', token, state),
        cleanup: async () => { throw new Error('操作失败'); } },
    });
    let value;
    switch (job.action) {
      case 'open': {
        let last = -Infinity, phase = '';
        const progress: ProgressCallback = event => {
          const now = performance.now();
          if (phase !== event.phase || now - last >= 100 || event.loaded === event.total) {
            worker.postMessage({ kind: 'progress', event }); phase = event.phase; last = now;
          }
        };
        await git.open(progress, job.allowClone); value = profile.branch; break;
      }
      case 'status': value = await git.status(); break;
      case 'review': value = await git.createReview(); break;
      case 'commit': value = await git.commit(job.message, job.confirmation); break;
      case 'sync': value = await git.sync(job.confirmation); break;
      case 'branch': value = await git.saveBranch(job.key, job.files); break;
    }
    worker.postMessage({ kind: 'done', value });
  } catch (error) { worker.postMessage({ kind: 'done', error: failure(error) }); }
};
