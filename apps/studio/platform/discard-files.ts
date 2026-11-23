import { checkout, type FsClient, type StatusRow } from 'isomorphic-git';

/** Explicit filepaths also remove reviewed untracked files. An empty path
 * list would select the entire checkout, so never pass one to Git. */
export async function discardFiles(options: { fs: FsClient; dir: string }, rows: StatusRow[]) {
  if (!rows.length) return;
  await checkout({ ...options, ref: 'HEAD', filepaths: rows.map(([path]) => path), force: true, noUpdateHead: true });
}
