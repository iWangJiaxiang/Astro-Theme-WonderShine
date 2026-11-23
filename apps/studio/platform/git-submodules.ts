import { addRemote, checkout, fetch, init, readBlob, readCommit, readTree, resolveRef, type AuthCallback, type HttpClient, type ProgressCallback } from 'isomorphic-git';
import { ensureDirectory, missingFile, type WorkspaceFiles } from './filesystem.js';
import { validateRemote } from './hosting.js';

export async function downloadSubmodules(files: WorkspaceFiles, dir: string, origin: string,
  httpFor: (url: string) => HttpClient, auth: AuthCallback, onProgress?: ProgressCallback) {
  const fs = { promises: files };
  const oid = await resolveRef({ fs, dir, ref: 'HEAD' });
  const top = await readTree({ fs, dir, oid });
  if (!top.tree.some(entry => entry.path === '.gitmodules' && entry.type === 'blob' && entry.mode !== '120000')) return;
  const { blob } = await readBlob({ fs, dir, oid, filepath: '.gitmodules' });
  const parent = validateRemote(origin);
  for (const { path, url } of submoduleEntries(new TextDecoder().decode(blob))) {
    const parts = path.split('/');
    if (parts.some(part => !part || /[. ]$|[\u0000-\u001f\u007f\\:]/.test(part)
      || /^(?:\.git|git~\d+|\.git~\d+)$/i.test(part.normalize('NFKC').replace(/\p{Cf}/gu, '')))) {
      throw new Error('Invalid submodule path');
    }
    // Only paths recorded as gitlinks may become repositories.
    const filename = parts.pop()!;
    const { tree } = parts.length ? await readTree({ fs, dir, oid, filepath: parts.join('/') }) : top;
    const pin = tree.find(entry => entry.path === filename && entry.type === 'commit')?.oid;
    if (!pin) continue;
    const remote = validateRemote(url.startsWith('./') || url.startsWith('../')
      ? new URL(url, parent.href.replace(/\/?$/, '/')).href
      : url);
    let target = dir;
    for (const part of [...parts, filename]) {
      target += '/' + part;
      await ensureDirectory(files, target);
    }
    if ((await files.readdir(target)).length) throw new Error('Submodule directory must be empty');
    const child = { fs, dir: target };
    const network = { ...child, url: remote.href, remote: 'origin', http: httpFor(remote.href),
      onAuth: remote.origin === parent.origin ? auth : undefined, onProgress };
    await init(child);
    await addRemote({ ...child, remote: 'origin', url: remote.href });
    try {
      await fetch({ ...network, remoteRef: pin, singleBranch: true, depth: 1 });
      await readCommit({ ...child, oid: pin });
    } catch {
      // Some servers reject wants for unadvertised commits. Try advertised history.
      const shallow = target + '/.git/shallow';
      try { await files.unlink(shallow); } catch (error) { if (!missingFile(error)) throw error; }
      await fetch({ ...network, remoteRef: 'HEAD', tags: true });
      await readCommit({ ...child, oid: pin });
    }
    await checkout({ ...child, ref: pin, onProgress, nonBlocking: true, batchSize: 8 });
  }
}

function submoduleEntries(config: string) {
  const entries: { path: string; url: string }[] = [];
  let current: Partial<(typeof entries)[number]> | undefined;
  for (const line of config.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      if (current?.path && current.url) entries.push({ path: current.path, url: current.url });
      current = /^\s*\[submodule\s+"(?:[^"\\]|\\.)+"\s*\]\s*(?:[;#].*)?$/i.test(line) ? {} : undefined;
      continue;
    }
    if (!current) continue;
    const match = /^\s*(path|url)\s*=\s*("(?:[^"\\]|\\.)*"|[^;#"]*?)\s*(?:[;#].*)?$/i.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase() as 'path' | 'url';
    current[key] = match[2].replace(/^"|"$/g, '').replace(/\\([\\"])/g, '$1');
  }
  if (current?.path && current.url) entries.push({ path: current.path, url: current.url });
  return entries;
}
