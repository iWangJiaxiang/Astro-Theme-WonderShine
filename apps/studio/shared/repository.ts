import type { MediaFile, MediaListing, MediaUploadResult } from './media.js';
import type { FileSnapshot, SaveResult } from './types.js';
import type { WorkspaceControl } from './workspace.js';
import { StudioError } from '../core/errors.js';

export function validatePath(path: string): void {
  if (typeof path !== 'string' || path.length > 500 || path.includes('\\') || /[\x00-\x1f\x7f%]/.test(path)
    || path.split('/').some(p => !p || p.startsWith('.'))
    || !(/^(config\.toml|data(?:\.[A-Za-z0-9-]+)?\.toml|public\/data\/friends(?:\.[A-Za-z0-9-]+)?\.json)$/.test(path)
      || /^content\/(articles|pages|collections|notes|topics)\/.+\.md$/.test(path) || /^content\/_index(?:\.[A-Za-z0-9-]+)?\.md$/.test(path))) {
    throw new StudioError(400, '不允许访问此文件路径');
  }
}
export type WriteGuard = (repository: Repository) => Promise<void>;
export interface RepositoryWrite { path: string; text: string | null; expectedRevision: string | null }
export interface Repository {
  readonly mode: 'local' | 'git';
  readonly saveScope?: string;
  readonly workspace?: WorkspaceControl;
  clearReadCache?(): void;
  read(path: string): Promise<FileSnapshot | null>;
  list(): Promise<FileSnapshot[]>;
  listMedia(refresh?: boolean): Promise<MediaListing>;
  readMedia(path: string): Promise<MediaFile | null>;
  uploadMedia(directory: string, name: string, data: Uint8Array): Promise<MediaUploadResult>;
  write(path: string, text: string | null, expectedRevision: string | null, guard?: WriteGuard): Promise<SaveResult>;
  writeBatch(entries: RepositoryWrite[], guard?: WriteGuard): Promise<SaveResult>;
}
