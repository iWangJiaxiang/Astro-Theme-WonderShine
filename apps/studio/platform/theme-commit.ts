import { hashBlob, readBlob, resolveRef } from 'isomorphic-git';
import { StudioError } from '../core/errors.js';
import type { ThemeCommit } from '../shared/theme-update.js';

export async function assertThemeCommit(options: Omit<Parameters<typeof readBlob>[0], 'oid' | 'filepath'>, change: ThemeCommit, read: (path: string) => Promise<Uint8Array | string>) {
  const head = await resolveRef({ ...options, ref: 'HEAD' });
  if (head !== change.head) throw new StudioError(409, '工作区已变化，请刷新并重新确认提交范围');
  for (const file of change.files) {
    if (!['config.toml', 'package.json', 'package-lock.json'].includes(file.path)) throw new StudioError(400, '不允许访问此文件路径');
    let before: string | null = null;
    try { before = (await readBlob({ ...options, oid: head, filepath: file.path })).oid; }
    catch (error) { if ((error as { code?: string }).code !== 'NotFoundError') throw error; }
    const bytes = await read(file.path);
    const { oid } = await hashBlob({ object: typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes });
    if (before !== file.before || oid !== file.after) throw new StudioError(409, '工作区已变化，请刷新并重新确认提交范围');
  }
}
