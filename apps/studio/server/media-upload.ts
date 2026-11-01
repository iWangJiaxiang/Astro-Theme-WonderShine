import { randomUUID } from 'node:crypto';
import { link, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { imageMime, type MediaUploadResult } from '../shared/media.js';
import { safeMediaPath, validateMediaPath } from './media-files.js';
import { StudioError } from './errors.js';

import { validateUpload } from '../core/media-validation.js';
export { readUploadBody, validateUpload } from '../core/media-validation.js';

export async function uploadMediaFile(root: string, directory: string, name: string, data: Uint8Array): Promise<MediaUploadResult> {
  validateUpload(directory, name, data);
  let path = `${directory}/${name}`;
  const destination = await safeMediaPath(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await safeMediaPath(root, path);
  const temporary = join(dirname(destination), `.studio-upload-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        // Exclusive hard-link creation makes the whole image visible atomically, never overwriting.
        validateMediaPath(path);
        await link(temporary, await safeMediaPath(root, path));
        return { item: { path, directory, name: path.slice(directory.length + 1), size: data.byteLength, mime: imageMime(path)! }, message: '图片已上传，网站部署后可公开访问' };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const dot = name.lastIndexOf('.');
        path = `${directory}/${name.slice(0, dot)}-${randomUUID().slice(0, 8)}${name.slice(dot)}`;
      }
    }
    throw new StudioError(409, '文件名冲突，请重新选择图片后上传');
  } finally { await rm(temporary, { force: true }); }
}
