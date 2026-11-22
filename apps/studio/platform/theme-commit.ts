import { hashBlob, readBlob, resolveRef } from 'isomorphic-git';
import { StudioError } from '../core/errors.js';
import { themeConfigPath } from '../core/theme-update.js';
import type { ThemeCommit } from '../shared/theme-update.js';

export async function assertThemeCommit(options: Omit<Parameters<typeof readBlob>[0], 'oid' | 'filepath'>, change: ThemeCommit, bytes: Uint8Array) {
  const head = await resolveRef({ ...options, ref: 'HEAD' });
  let before: string | null = null;
  try { before = (await readBlob({ ...options, oid: head, filepath: themeConfigPath })).oid; }
  catch (error) { if ((error as { code?: string }).code !== 'NotFoundError') throw error; }
  const { oid: after } = await hashBlob({ object: bytes });
  if (head !== change.head || before !== change.before || after !== change.after) {
    throw new StudioError(409, '工作区已变化，请刷新并重新确认提交范围');
  }
}
