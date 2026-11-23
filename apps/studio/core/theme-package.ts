// Standalone sites commit exact versions so npm ci can reproduce a Studio save.
import type { Repository, RepositoryWrite } from '../shared/repository.js';
import type { FileSnapshot } from '../shared/types.js';
import { isDeepStrictEqual } from './portable.js';
import { StudioError } from './errors.js';

const name = '@wondershine/theme';
const entryPath = 'node_modules/' + name;
const lockError = () => new StudioError(409, '主题依赖关系有变化或锁文件不兼容，请先用 npm 更新站点锁文件');
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

function readJson(file: FileSnapshot) {
  try {
    const value = JSON.parse(file.text);
    if (object(value)) return value;
  } catch { /* Report the affected site file below. */ }
  throw new StudioError(400, '站点文件格式无效：{path}', { path: file.path });
}

export async function readThemePackage(repo: Repository) {
  const file = await repo.read('package.json');
  if (!file) return null; // Older content-only repositories use the config-based integration.
  const manifest = readJson(file);
  const spec = manifest.dependencies?.[name];
  if (typeof spec !== 'string' || !/^(?:latest|next|canary|[~^]?\d+\.\d+\.\d+(?:-(?:beta|rc|canary)\.\d+)?)$/.test(spec) || manifest.workspaces) {
    throw new StudioError(400, '请先为独立博客配置 npm registry 主题依赖');
  }
  const lockFile = await repo.read('package-lock.json');
  const lock = lockFile && readJson(lockFile);
  const entry = lock?.packages?.[entryPath];
  if (lock && (lock.lockfileVersion !== 3 || !object(entry) || entry.link || lock.packages?.['']?.dependencies?.[name] !== spec)) throw lockError();
  return { file, manifest, lockFile, lock, currentVersion: entry?.version ?? spec };
}

function jsonWrite(file: FileSnapshot, value: unknown): RepositoryWrite {
  const indent = file.text.match(/\n([ \t]+)"/)?.[1];
  const text = JSON.stringify(value, null, indent).replace(/\n/g, file.text.includes('\r\n') ? '\r\n' : '\n')
    + (file.text.match(/(?:\r?\n)$/)?.[0] ?? '');
  return { path: file.path, expectedRevision: file.revision, text };
}

type SitePackage = Awaited<ReturnType<typeof readThemePackage>>;

export const packageRevision = (site: SitePackage) => site ? JSON.stringify([site.file.revision, site.lockFile?.revision ?? null]) : undefined;

export async function checkPackageRevision(repo: Repository, site: SitePackage) {
  const [manifest, lock] = await Promise.all([repo.read('package.json'), site ? repo.read('package-lock.json') : null]);
  if (manifest?.revision !== site?.file.revision || lock?.revision !== site?.lockFile?.revision) {
    throw new StudioError(409, '文件已更新，请重新加载并合并修改');
  }
}

export async function themePackageWrites(site: NonNullable<SitePackage>, version: string, request: typeof fetch) {
  const { manifest, file, lock, lockFile } = site;
  const writes: RepositoryWrite[] = [];
  if (manifest.dependencies[name] !== version) {
    manifest.dependencies[name] = version;
    writes.push(jsonWrite(file, manifest));
  }
  if (!lock || !lockFile) return writes;
  const entry = lock.packages[entryPath];
  const root = lock.packages[''].dependencies;
  if (entry.version === version && root[name] === version) return writes;
  if (entry.version !== version) {
    let release;
    try {
      const response = await request('https://registry.npmjs.org/@wondershine%2ftheme/' + version, {
        signal: AbortSignal.timeout(15000), cache: 'no-store', credentials: 'omit', redirect: 'error',
      });
      if (!response.ok) throw new Error();
      release = await response.json();
      if (release.name !== name || release.version !== version || release.dist?.tarball !== `https://registry.npmjs.org/${name}/-/theme-${version}.tgz`
        || typeof release.dist.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(release.dist.integrity)) throw new Error();
    } catch { throw new StudioError(502, '无法获取所选渠道的主题版本，请联网后重试'); }
    // A changed dependency graph needs a full npm resolution, never a partial lock.
    for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'bundleDependencies', 'bin', 'os', 'cpu', 'libc']) {
      if (!isDeepStrictEqual(entry[key], release[key])) throw lockError();
    }
    if (!!entry.hasInstallScript !== ['preinstall', 'install', 'postinstall'].some(k => release.scripts?.[k])) throw lockError();
    Object.assign(entry, { version, resolved: release.dist.tarball, integrity: release.dist.integrity });
    for (const key of ['engines', 'license', 'deprecated', 'funding']) {
      if (release[key] === undefined) delete entry[key];
      else entry[key] = release[key];
    }
  }
  root[name] = version;
  writes.push(jsonWrite(lockFile, lock));
  return writes;
}
