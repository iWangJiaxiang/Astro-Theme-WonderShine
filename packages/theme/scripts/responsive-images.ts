import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp, { type Metadata, type OutputInfo } from 'sharp';
import { imageManifestPath, type ImageManifest, type ImageMetadata, type ImageVariant } from '../src/lib/image-assets';

const widths = [96, 240, 480, 800, 1200, 1600];
const recipe = `responsive-v1:${sharp.versions.sharp}:webp74:avif44-effort3:${widths.join(',')}`;
const raster = /\.(?:jpe?g|png|webp|avif)$/i;
async function files(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['_images', 'processed_images'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(file));
    else if (entry.isFile() && raster.test(entry.name)) result.push(file);
  }
  return result;
}

async function encode(buffer: Buffer, hash: string, cache: string): Promise<ImageMetadata | undefined> {
  const record = path.join(cache, hash + '.json');
  try {
    const entry = JSON.parse(await fs.readFile(record, 'utf8')) as ImageMetadata;
    await Promise.all([...entry.webp, ...entry.avif].map(item => fs.access(path.join(cache, path.basename(item.src)))));
    return entry;
  } catch { /* A missing or incomplete cache entry is safely regenerated. */ }
  let metadata: Metadata;
  try { metadata = await sharp(buffer, { limitInputPixels: 80_000_000 }).metadata(); }
  catch { return; } // Unsupported or corrupt originals remain available at their original URL.
  if (!metadata.width || !metadata.height || (metadata.pages || 1) > 1) return;
  const rotated = metadata.orientation && metadata.orientation >= 5;
  const width = rotated ? metadata.height : metadata.width, height = rotated ? metadata.width : metadata.height;
  const entry: ImageMetadata = { width, height, originalBytes: buffer.length, webp: [], avif: [] };
  const selected = [...new Set([...widths.filter(size => size < width), Math.min(width, widths.at(-1)!)] )];
  for (const size of selected) {
    for (const format of ['webp', 'avif'] as const) {
      const name = `${hash}-${size}.${format}`, target = path.join(cache, name);
      let result: { data: Buffer; info: OutputInfo };
      try {
        const pipeline = sharp(buffer, { limitInputPixels: 80_000_000 }).rotate().resize({ width: size, withoutEnlargement: true });
        const encoded = format === 'webp' ? pipeline.webp({ quality: 74, effort: 4 }) : pipeline.avif({ quality: 44, effort: 3 });
        result = await encoded.toBuffer({ resolveWithObject: true });
      } catch {
        // Valid headers do not guarantee readable pixels; retain the original URL.
        return;
      }
      const { data, info } = result;
      const temporary = target + '.' + randomUUID();
      await fs.writeFile(temporary, data);
      await fs.rename(temporary, target);
      entry[format].push({ src: `/_images/${name}`, width: info.width, height: info.height, bytes: data.length } satisfies ImageVariant);
    }
  }
  const temporary = record + '.' + randomUUID();
  await fs.writeFile(temporary, JSON.stringify(entry));
  await fs.rename(temporary, record);
  return entry;
}

/** Encode each image digest once; source URLs and originals remain untouched. */
export async function prepareResponsiveImages(root: string, publicRoot: string): Promise<ImageManifest> {
  const cache = path.resolve(process.env.ASTRO_IMAGE_CACHE_DIR || path.join(root, '.astro/images/cache'));
  const output = path.join(publicRoot, '_images');
  await fs.mkdir(cache, { recursive: true });
  await fs.mkdir(output, { recursive: true });
  const manifest: ImageManifest = {}, pending = await files(publicRoot);
  const work = new Map<string, Promise<ImageMetadata | undefined>>();
  const copied = new Set<string>();
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (pending.length) {
      const file = pending.pop()!;
      const buffer = await fs.readFile(file);
      const hash = createHash('sha256').update(recipe).update(buffer).digest('hex').slice(0, 24);
      if (!work.has(hash)) work.set(hash, encode(buffer, hash, cache));
      const entry = await work.get(hash);
      if (!entry) continue;
      manifest['/' + path.relative(publicRoot, file).split(path.sep).join('/')] = entry;
      for (const variant of [...entry.webp, ...entry.avif]) {
        if (copied.has(variant.src)) continue;
        copied.add(variant.src);
        await fs.copyFile(path.join(cache, path.basename(variant.src)), path.join(output, path.basename(variant.src)));
      }
    }
  }));
  return manifest;
}

export async function publishImageManifest(root: string, manifest: ImageManifest, target = imageManifestPath(root)) {
  const temporary = target + '.' + randomUUID();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temporary, JSON.stringify(manifest));
  await fs.rename(temporary, target);
}
