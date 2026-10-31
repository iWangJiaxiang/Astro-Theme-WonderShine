import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadSite } from '../src/lib/content';
import { prepareResponsiveImages, publishImageManifest } from './responsive-images';

import { themePath } from '../src/lib/theme-paths';
const inside = (parent: string, child: string) => child === parent || child.startsWith(parent + path.sep);

export function assetSourceDirectories(root: string) {
  return [themePath('assets'), path.resolve(root, 'static'), path.resolve(root, 'public')];
}
export function siteConfigurationFiles(root: string, catalogPath?: string): string[] {
  return [path.join(root, 'config.toml'), path.join(root, 'compatibility/heading-aliases.json'), themePath('defaults/config.toml'),
    themePath('locales/theme.toml'), themePath('locales/activity.toml'), ...(catalogPath ? [path.resolve(root, catalogPath)] : [])];
}

/** Filesystem inputs are outside Astro's module graph, so dev must watch them explicitly. */
export function isSiteInput(filename: string, root: string, catalogPath?: string): boolean {
  const absolute = path.resolve(filename);
  if (siteConfigurationFiles(root, catalogPath).includes(absolute)) return true;
  if ([path.resolve(root, 'content'), ...assetSourceDirectories(root)].some(source => inside(source, absolute))) return true;
  return path.dirname(absolute) === path.resolve(root) && /^(?:config\.toml|data(?:\.[^.]+)?\.toml|_headers|_redirects)$/.test(path.basename(absolute));
}

/** Prepare only static resources; Astro owns all page generation. */
export async function prepareAssets(root: string, destination: string) {
  root = path.resolve(root);
  destination = path.resolve(destination);
  const site = await loadSite({ root });
  const sources = assetSourceDirectories(root);
  if (inside(destination, root) || [path.join(root, 'content'), ...sources].some(source => inside(source, destination) || inside(destination, source))) {
    throw new Error('Generated assets must be outside source directories');
  }
  const staging = destination + `.staging-${randomUUID()}`;
  const previous = destination + `.previous-${randomUUID()}`;
  let movedPrevious = false;
  await fs.mkdir(staging, { recursive: true });
  try {
    for (const source of sources) {
      if (await fs.stat(source).then(s => s.isDirectory()).catch(() => false)) {
        await fs.cp(source, staging, { recursive: true, filter: async file =>
          !path.basename(file).startsWith('.') && !(await fs.lstat(file)).isSymbolicLink() });
      }
    }
    for (const asset of site.assets) {
      const target = path.resolve(staging, '.' + asset.path);
      if (!target.startsWith(staging + path.sep)) throw new Error(`Unsafe asset path: ${asset.path}`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(asset.source, target);
    }
    for (const name of ['_headers', '_redirects']) {
      await fs.copyFile(path.join(root, name), path.join(staging, name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    const images = await prepareResponsiveImages(root, staging);
    await publishImageManifest(root, images, path.join(staging, '_images/manifest.json'));
    // Publish a complete snapshot only after all reads succeed, including deletions.
    await fs.rename(destination, previous).then(() => { movedPrevious = true; }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    try { await fs.rename(staging, destination); }
    catch (error) { if (movedPrevious) await fs.rename(previous, destination); throw error; }
    if (movedPrevious) await fs.rm(previous, { recursive: true, force: true });
    await publishImageManifest(root, images);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
