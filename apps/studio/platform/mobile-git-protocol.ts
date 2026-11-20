import type { GitHttpRequest, GitHttpResponse } from 'isomorphic-git';
import { StudioError } from '../core/errors';
import type { BranchFile } from '../shared/save';
import type { ReviewState, WorkspaceReview } from '../shared/workspace-confirmation';
import type { FileInfo, WorkspaceFiles } from './filesystem';
import type { WorkspaceProfile } from './hosting';

export type GitJob = { action: 'open'; allowClone: boolean } | { action: 'status' | 'review' }
  | { action: 'commit'; message: string; confirmation?: string } | { action: 'commitForReview'; message: string; confirmation: string } | { action: 'sync'; confirmation?: string }
  | { action: 'branch'; key: string; files: BranchFile[] };
export type JobRequest = { job: GitJob; root: string; state: string; profile: WorkspaceProfile; password: string; reviewPaths?: string[] };
export type StatInfo = Omit<FileInfo, 'isFile' | 'isDirectory' | 'isSymbolicLink'> & { file: boolean; directory: boolean; symlink: boolean };
export type DeviceIO = Pick<WorkspaceFiles, 'readFile' | 'writeFile' | 'readdir' | 'mkdir' | 'rmdir' | 'unlink' | 'rename' | 'chmod'> & {
  stat(path: string, link: boolean): Promise<StatInfo>;
  request(request: Pick<GitHttpRequest, 'url' | 'method' | 'headers'>, bytes?: Uint8Array): Promise<Omit<GitHttpResponse, 'body'> & { id: number }>;
  readBody(id: number): Promise<Uint8Array | null>;
  closeBody(id: number): Promise<void>;
  review(state: ReviewState): Promise<WorkspaceReview>;
  validate(token: unknown, state: ReviewState): Promise<void>;
};

type Failure = { message: string; code?: string; status?: number; params?: StudioError['params'] };
export function failure(error: unknown): Failure {
  const value = error as Error & { code?: string };
  return { message: value?.message || '操作失败', code: value?.code,
    ...(error instanceof StudioError ? { status: error.status, params: error.params } : {}) };
}
export function restoreError(error: Failure) {
  return error.status ? new StudioError(error.status, error.message, error.params)
    : Object.assign(new Error(error.message), { code: error.code });
}
