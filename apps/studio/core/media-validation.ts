import { SaxesParser } from 'saxes';
import { imageExtension, imageMime, MAX_UPLOAD_SIZE } from '../shared/media.js';
import { StudioError } from './errors.js';

export function validateMediaPath(path: string): void {
  if (typeof path !== 'string' || path.length > 1000 || !/^(public|content)\//.test(path) || !imageMime(path)
    || /[\\\x00-\x1f\x7f%?#]/.test(path) || path.split('/').some(part => !part || part.startsWith('.')))
    throw new StudioError(400, '请选择仓库 public 或 content 目录中的图片');
}
export async function readUploadBody(request: Request, maxSize = MAX_UPLOAD_SIZE): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxSize) {
        await reader.cancel();
        throw new StudioError(413, '每张图片不能超过 {limit} MB', { limit: maxSize / 1024 / 1024 });
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally { reader.releaseLock(); }
}

// SVGs become public site assets after deployment, so preview CSP alone is insufficient.
const svgTags = new Set('svg g defs symbol use path rect circle ellipse line polyline polygon text tspan title desc linearGradient radialGradient stop clipPath mask pattern marker filter feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG feFuncR feGaussianBlur feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting feSpotLight feTile feTurbulence'.split(' '));
const svgStyleProperties = new Set('fill fill-rule fill-opacity stroke stroke-width stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset stroke-opacity opacity color stop-color stop-opacity flood-color flood-opacity lighting-color display visibility font-size font-weight font-style text-anchor dominant-baseline clip-rule clip-path mask filter vector-effect paint-order shape-rendering'.split(' '));
function safeSvgStyle(style: string): boolean {
  return style.split(';').filter(part => part.trim()).every(declaration => {
    const match = /^\s*([a-z-]+)\s*:\s*(.+?)\s*$/i.exec(declaration);
    if (!match || !svgStyleProperties.has(match[1].toLowerCase())) return false;
    const value = match[2];
    return /^[\w\s#.,%+-]+$/.test(value)
      || /^(?:rgb|rgba|hsl|hsla)\([\d\s.,%+/-]+\)$/i.test(value)
      || /^url\(\s*['"]?#[\w:.-]+['"]?\s*\)$/i.test(value);
  });
}
const asciiText = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
function isAvif(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || asciiText(bytes, 4, 8) !== 'ftyp') return false;
  let size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0), start = 8;
  if (size === 1) {
    if (bytes.length < 24) return false;
    const extended = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(8);
    if (extended > BigInt(bytes.length)) return false;
    size = Number(extended); start = 16;
  }
  if (size < start + 8 || size > bytes.length || (size - start) % 4 !== 0) return false;
  const brands = [asciiText(bytes, start, start + 4)];
  for (let offset = start + 8; offset < size; offset += 4) brands.push(asciiText(bytes, offset, offset + 4));
  return brands.some(brand => brand === 'avif' || brand === 'avis');
}
function validateSvg(data: Uint8Array) {
  const fail = () => { throw new StudioError(400, 'SVG 必须是有效的静态图片，不能包含脚本、动画或外部资源'); };
  try {
    const parser = new SaxesParser({ xmlns: true });
    let root = false;
    parser.on('error', fail); parser.on('doctype', fail); parser.on('processinginstruction', fail);
    parser.on('opentag', tag => {
      if (!root && tag.local !== 'svg') fail();
      root = true;
      if (tag.uri !== 'http://www.w3.org/2000/svg' || !svgTags.has(tag.local)) fail();
      for (const attribute of Object.values(tag.attributes)) {
        if (attribute.uri === 'http://www.w3.org/2000/xmlns/') continue;
        const name = attribute.local.toLowerCase(), value = attribute.value;
        if (name === 'style' && !safeSvgStyle(value)) fail();
        if (name.startsWith('on') || (attribute.uri && !['http://www.w3.org/1999/xlink', 'http://www.w3.org/XML/1998/namespace'].includes(attribute.uri))) fail();
        if (name === 'base' || (name === 'href' && !/^#[\w:.-]+$/.test(value))) fail();
        // Reject CSS escapes/imports and permit only same-document paint references.
        if (/[\\@]/.test(value) || /(?:javascript|data|https?|expression)\s*:/i.test(value)
          || /url\s*\(/i.test(value.replace(/url\(\s*['"]?#[\w:.-]+['"]?\s*\)/gi, ''))) fail();
      }
    });
    parser.write(new TextDecoder('utf-8', { fatal: true }).decode(data)).close();
    if (!root) fail();
  } catch (error) { if (error instanceof StudioError) throw error; fail(); }
}

export function validateUpload(directory: string, name: string, data: Uint8Array): void {
  if (typeof directory !== 'string' || !/^(?:public(?:\/[^/]+)*|content\/(?:articles|pages|collections|threads|topics)\/.+)$/.test(directory)
    || directory.split('/').some(part => ['node_modules', 'processed_images', 'dist'].includes(part))
    || typeof name !== 'string' || !name.trim() || new TextEncoder().encode(name).byteLength > 200 || /[/\\]/.test(name))
    throw new StudioError(400, '上传目录或文件名无效');
  validateMediaPath(`${directory}/${name}`);
  if (!data.byteLength) throw new StudioError(400, '不能上传空文件');
  if (data.byteLength > MAX_UPLOAD_SIZE) throw new StudioError(413, '每张图片不能超过 20 MB');
  const bytes = data, extension = imageExtension(name);
  if (extension === 'svg') { validateSvg(data); return; }
  const ascii = (start: number, end: number) => asciiText(bytes, start, end);
  const matches: Record<string, boolean> = {
    png: bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value),
    jpg: bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
    jpeg: bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
    gif: bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6)),
    webp: bytes.length >= 16 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(ascii(12, 16)),
    bmp: bytes.length >= 26 && ascii(0, 2) === 'BM',
    ico: bytes.length >= 22 && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) === 65536 && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(4, true) > 0,
    avif: isAvif(bytes),
  };
  if (!Object.hasOwn(matches, extension) || !matches[extension]) throw new StudioError(400, '图片内容与文件格式不匹配，请选择有效的图片');
}

