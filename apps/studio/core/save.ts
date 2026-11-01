import { saveMediaValues } from './save-media.js';
import { storedMediaPath } from '../shared/media.js';
import { validateMediaPath } from './media-validation.js';
import type { Repository, RepositoryWrite, WriteGuard } from '../shared/repository.js';
import type { SaveCapabilities, SaveMode, BranchFile } from '../shared/save.js';
import type { SaveResult } from '../shared/types.js';
import { StudioError } from './errors.js';

export function saveCapabilities(repository: Repository): SaveCapabilities {
  return { modes: repository.workspace?.saveBranch ? ['local', 'branch'] : repository.mode === 'local' || repository.workspace ? ['local'] : ['remote'] };
}
export function validateSaveMode(repository: Repository, mode?: unknown): SaveMode {
  const { modes } = saveCapabilities(repository);
  if (mode === undefined) return modes[0];
  if (!modes.includes(mode as SaveMode)) throw new StudioError(400, '当前工作区不支持此保存方式');
  return mode as SaveMode;
}

/** Local persistence is acknowledged even when the independent branch operation fails. */
export async function saveBatch(repository: Repository, entries: RepositoryWrite[], guard?: WriteGuard, requested?: unknown): Promise<SaveResult> {
  const mode = validateSaveMode(repository, requested);
  const result = await repository.writeBatch(entries, guard);
  if (mode !== 'branch') return result;
  try {
    const files: BranchFile[] = entries.map(entry => ({ path: entry.path, data: entry.text === null ? null : new TextEncoder().encode(entry.text) }));
    // Retain existing locale sections on retries too, when localeSectionWrites is empty.
    const directories = new Set(entries.filter(entry => entry.path.startsWith('content/')).flatMap(entry => {
      const parts = entry.path.split('/'); parts.pop();
      return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
    }));
    const language = entries[0].path.match(/\.([A-Za-z0-9-]+)\.md$/)?.[1];
    for (const directory of directories) {
      for (const suffix of language ? ['', `.${language}`] : ['']) {
        const path = `${directory}/_index${suffix}.md`;
        if (files.some(file => file.path === path)) continue;
        const file = await repository.read(path);
        if (file) files.push({ path, data: new TextEncoder().encode(file.text), onlyIfMissing: true });
      }
    }
    // Include only media explicitly referenced by this save, never the whole media library.
    for (const entry of entries) {
      for (const reference of saveMediaValues(entry.path, entry.text ?? '')) {
        let value: string;
        try { value = decodeURIComponent(reference.split(/[?#]/)[0]); } catch { continue; }
        const path = storedMediaPath(value, 'document', entry.path);
        if (!path || files.some(file => file.path === path)) continue;
        try { validateMediaPath(path); } catch { continue; }
        const media = await repository.readMedia(path);
        if (media) files.push({ path, data: media.data });
      }
    }
    const saved = await repository.workspace!.saveBranch!(entries[0].path, files);
    return { ...result, ...saved, message: '已保存到本地 Git 分支，尚未推送或合并' };
  } catch {
    return { ...result, branchPending: true, message: '本地文件已保存，Git 分支提交未完成，请重试分支保存' };
  }
}
