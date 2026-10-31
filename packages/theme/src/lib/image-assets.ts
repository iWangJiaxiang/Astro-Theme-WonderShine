import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Site } from './types';

export interface ImageVariant { src: string; width: number; height: number; bytes: number }
export interface ImageMetadata { width: number; height: number; originalBytes: number; webp: ImageVariant[]; avif: ImageVariant[] }
export type ImageManifest = Record<string, ImageMetadata>;
const cache = new Map<string, { version: string; images: ImageManifest }>();

export function imageManifestPath(root: string): string { return path.join(root, '.astro/images/manifest.json'); }

/** Resolve only known local assets. Remote URLs are never fetched by this helper. */
export function localImagePath(src: string, baseUrl?: string): string | undefined {
  if (!src || /^(?:data:|blob:)/i.test(src) || src.startsWith('//')) return;
  try {
    let value = src;
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value);
      if (!baseUrl || url.origin !== new URL(baseUrl).origin) return;
      value = url.pathname;
    }
    if (!value.startsWith('/') || value.includes('\\')) return;
    const pathname = decodeURIComponent(value.split(/[?#]/)[0]);
    if (pathname.split('/').some(part => part === '..' || part === '.') || /[\u0000-\u001f]/.test(pathname)) return;
    return pathname;
  } catch { return; }
}

export function readImageManifest(root: string): ImageManifest {
  const filename = process.env.ASTRO_IMAGE_MANIFEST_PATH || imageManifestPath(root);
  try {
    const stat = statSync(filename), version = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    const cached = cache.get(filename);
    if (cached?.version === version) return cached.images;
    const images = JSON.parse(readFileSync(filename, 'utf8')) as ImageManifest;
    cache.set(filename, { version, images });
    return images;
  } catch { return {}; }
}

/** Metadata is shared by Astro components and string-based Markdown/shortcode renderers. */
export function responsiveImage(site: Pick<Site, 'root' | 'config'>, src: string, preferredWidth = 800) {
  const key = localImagePath(src, site.config.base_url);
  const metadata = key ? readImageManifest(site.root)[key] : undefined;
  const fallback = metadata?.webp.find(item => item.width >= preferredWidth) || metadata?.webp.at(-1);
  const srcset = (variants?: ImageVariant[]) => variants?.length ? variants.map(item => `${item.src} ${item.width}w`).join(', ') : undefined;
  return {
    original: src,
    src: fallback?.src || src,
    width: metadata?.width,
    height: metadata?.height,
    webpSrcset: srcset(metadata?.webp),
    avifSrcset: srcset(metadata?.avif),
    metadata,
  };
}
