export interface FileInfo { size: number; mtimeMs: number; ctimeMs: number; mode: number; dev: number; ino: number; uid: number; gid: number; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }
export interface DirectoryEntry { name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }
/** Minimal Node-compatible promises surface consumed by isomorphic-git. */
export interface WorkspaceFiles {
  readFile(path: string, options?: unknown): Promise<Uint8Array | string>;
  /** Optional capabilities must freshly reject symlinks in the root and all path components.
   * Reads check file type before I/O and byte limits before and after I/O. Entries are discovery hints,
   * never authorization for a later read. Adapters without these retain repository checks. */
  readCheckedFile?(path: string, limit: number): Promise<Uint8Array>;
  readCheckedDirectory?(path: string): Promise<DirectoryEntry[]>;
  writeFile(path: string, data: Uint8Array | string, options?: unknown): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rmdir(path: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  stat(path: string): Promise<FileInfo>;
  lstat(path: string): Promise<FileInfo>;
  readlink(path: string): Promise<string>;
  symlink(target: string, path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
}
export const missingFile = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
export const parentPath = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
export async function ensureDirectory(fs: WorkspaceFiles, path: string): Promise<void> {
  try { const info = await fs.lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('目录不可用'); }
  catch (error) { if (!missingFile(error)) throw error; await ensureDirectory(fs, parentPath(path)); await fs.mkdir(path); }
}
