import './buffer.js';
import { commit, findMergeBase, readTree, writeTree, type FsClient, type TreeEntry } from 'isomorphic-git';
import { StudioError } from '../core/errors.js';

const conflict = () => new StudioError(409, '无法自动合并，请在 Git 工具中处理；双方提交均已保留');
const same = (a?: TreeEntry, b?: TreeEntry) => a?.oid === b?.oid && a?.mode === b?.mode;

/** Build a two-parent commit without touching HEAD, the index or working files. */
export async function mergeTarget(fs: FsClient, dir: string, local: string, remote: string, author: { name: string; email: string }) {
  const options = { fs, dir, cache: {} };
  const bases = await findMergeBase({ ...options, oids: [local, remote] });
  if (bases.length !== 1) throw conflict();

  async function entries(oid?: string) {
    const tree = oid ? (await readTree({ ...options, oid })).tree : [];
    return new Map(tree.map(entry => [entry.path, entry]));
  }
  async function mergeTrees(base: string | undefined, ours: string, theirs: string): Promise<string> {
    const [before, left, right] = await Promise.all([entries(base), entries(ours), entries(theirs)]);
    const tree: TreeEntry[] = [];
    for (const path of new Set([...left.keys(), ...right.keys()])) {
      const a = left.get(path), b = right.get(path), old = before.get(path);
      let next: TreeEntry | undefined;
      if (same(a, b) || same(old, b)) next = a;
      else if (same(old, a)) next = b;
      else if (a?.type === 'tree' && b?.type === 'tree' && (!old || old.type === 'tree')) {
        next = { ...a, oid: await mergeTrees(old?.oid, a.oid, b.oid) };
      } else throw conflict();
      if (next) tree.push(next);
    }
    return writeTree({ ...options, tree });
  }
  const tree = await mergeTrees(bases[0], local, remote);
  return commit({ ...options, tree, parent: [local, remote], author, noUpdateBranch: true, message: 'Merge remote workspace changes' });
}
