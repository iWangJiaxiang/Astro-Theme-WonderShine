import GitWorker from './mobile-git.worker?worker&inline';
import type { HttpClient, ProgressCallback } from 'isomorphic-git';
import { StudioError } from '../core/errors';
import type { BranchSave } from '../shared/save';
import type { WorkspaceControl, WorkspaceStatus } from '../shared/workspace';
import type { WorkspaceReviewAdapter } from '../shared/workspace-confirmation';
import type { WorkspaceFiles } from './filesystem';
import type { WorkspaceProfile } from './hosting';
import { failure, restoreError, type DeviceIO, type GitJob, type JobRequest } from './mobile-git-protocol';
import { withWorkspaceLock } from './queue';

export function mobileGit(files: WorkspaceFiles, root: string, state: string, profile: WorkspaceProfile,
  http: HttpClient, password: () => string, reviews: WorkspaceReviewAdapter) {
  // Acquire the same queue as FileRepository BEFORE starting the worker, and hold
  // it until every dispatched device write has settled, including on worker failure.
  function run<T>(job: GitJob, onProgress?: ProgressCallback): Promise<T> {
    return withWorkspaceLock(root, async () => {
      const worker = new GitWorker({ name: 'Studio Git' });
      const pending = new Set<Promise<void>>();
      const bodies = new Map<number, AsyncIterableIterator<Uint8Array>>();
      let responseId = 0;
      const io: DeviceIO = {
        readFile: files.readFile, writeFile: files.writeFile, readdir: files.readdir,
        mkdir: files.mkdir, rmdir: files.rmdir, unlink: files.unlink, rename: files.rename, chmod: files.chmod,
        async stat(path, link) {
          const info = await (link ? files.lstat(path) : files.stat(path));
          const { isFile, isDirectory, isSymbolicLink, ...fields } = info;
          return { ...fields, file: info.isFile(), directory: info.isDirectory(), symlink: info.isSymbolicLink() };
        },
        async request(request, bytes) {
          const { body, ...response } = await http.request({ ...request, body: bytes && (async function* () { yield bytes; })() });
          const id = ++responseId;
          if (body) bodies.set(id, body);
          return { ...response, id };
        },
        async readBody(id) {
          const part = await bodies.get(id)?.next();
          return !part || part.done ? null : part.value;
        },
        async closeBody(id) { const body = bodies.get(id); bodies.delete(id); await body?.return?.(); },
        review: snapshot => reviews.store.createReview(snapshot, reviews.source),
        validate: (token, snapshot) => reviews.store.validateReview(token, snapshot, reviews.source),
      };
      const reply = async (method: keyof DeviceIO, args: unknown[], port: MessagePort) => {
        try {
          if (!Object.hasOwn(io, method)) throw new Error('操作失败');
          const value = await Reflect.apply(io[method] as (...args: unknown[]) => unknown, io, args);
          // Native reads return owned buffers. Transfer ownership without copying pack data.
          const transfer = value instanceof Uint8Array && value.buffer instanceof ArrayBuffer ? [value.buffer] : [];
          port.postMessage({ value }, transfer);
        } catch (error) { port.postMessage({ error: failure(error) }); }
        finally { port.close(); }
      };
      try {
        return await new Promise<T>((resolve, reject) => {
          worker.onmessage = ({ data, ports }) => {
            if (data.kind === 'done') { if (data.error) reject(restoreError(data.error)); else resolve(data.value); }
            else if (data.kind === 'progress') onProgress?.(data.event);
            else if (data.kind === 'io') {
              const task = reply(data.method, data.args, ports[0]);
              pending.add(task); void task.then(() => pending.delete(task), reject);
            }
          };
          worker.onerror = worker.onmessageerror = () => reject(new StudioError(503, 'Git 处理已中断，请检查工作区后重试。'));
          worker.postMessage({ job, root, state, profile, password: job.action === 'open' || job.action === 'sync' ? password() : '' } satisfies JobRequest);
        });
      } finally {
        worker.onmessage = null;
        worker.terminate();
        await Promise.allSettled(pending);
        await Promise.allSettled([...bodies.keys()].map(id => io.closeBody(id)));
      }
    });
  }
  const workspace: WorkspaceControl & { open(onProgress?: ProgressCallback, allowClone?: boolean): Promise<void> } = {
    async open(progress, allowClone = true) { profile.branch = await run<string>({ action: 'open', allowClone }, progress); },
    status: () => run<WorkspaceStatus>({ action: 'status' }),
    createReview: () => run<WorkspaceStatus>({ action: 'review' }),
    commit: (message, confirmation) => run<WorkspaceStatus>({ action: 'commit', message, confirmation }),
    sync: confirmation => run<WorkspaceStatus>({ action: 'sync', confirmation }),
    saveBranch: (key, files) => run<BranchSave>({ action: 'branch', key, files }),
  };
  return workspace;
}
