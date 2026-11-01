import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const studio = fileURLToPath(new URL('../../', import.meta.url));
const tauri = path.join(studio, 'src-tauri');
const cli = fileURLToPath(new URL('../../../../node_modules/@tauri-apps/cli/tauri.js', import.meta.url));
const platform = process.argv[2] || 'desktop';
// Run AFTER mobile init: Tauri writes directly into the generated native projects.
execFileSync(process.execPath, [cli, 'icon', 'src-tauri/app-icon.svg', '--output', 'src-tauri/icons', '--ios-color', '#425aef'], { cwd: studio, stdio: 'inherit' });
async function checkIcon(file, size, opaque = false, masked = false) {
  const input = sharp(file), metadata = await input.metadata();
  assert.equal(metadata.width, size); assert.equal(metadata.height, size);
  const { data, info } = await input.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (opaque) for (let i = 3; i < data.length; i += info.channels) assert.equal(data[i], 255, 'iOS icons must be opaque');
  const pixel = (x, y) => [...data.subarray((y * size + x) * 4, (y * size + x) * 4 + 3)];
  if (!masked) assert.deepEqual(pixel(0, 0), [66, 90, 239], 'Brand background must reach the icon edges');
  // The W center stroke is white, the upper center background is blue.
  let whiteStroke = false;
  for (let y = Math.floor(size * .35); y < size * .65; y++) for (let x = Math.floor(size * .35); x < size * .65; x++) {
    if (pixel(x, y).every(value => value > 220)) whiteStroke = true;
  }
  assert.ok(whiteStroke, 'WonderShine W stroke missing');
}
if (platform === 'ios') {
  const directory = path.join(tauri, 'gen/apple/Assets.xcassets/AppIcon.appiconset');
  const catalog = JSON.parse(await readFile(path.join(directory, 'Contents.json'), 'utf8'));
  assert.ok(catalog.images.length > 0, 'Xcode must have an AppIcon catalog');
  for (const item of catalog.images) {
    assert.ok(item.filename, 'Every AppIcon slot must have an image');
    const size = Math.round(Number(item.size.split('x')[0]) * Number(item.scale.replace('x', '')));
    await checkIcon(path.join(directory, item.filename), size, true);
  }
} else if (platform === 'android') {
  const directory = path.join(tauri, 'gen/android/app/src/main/res');
  const folders = (await readdir(directory)).filter(name => /^mipmap-(mdpi|hdpi|xhdpi|xxhdpi|xxxhdpi)$/.test(name));
  assert.equal(folders.length, 5);
  for (const folder of folders) {
    const file = path.join(directory, folder, 'ic_launcher.png');
    const { width } = await sharp(file).metadata();
    await checkIcon(file, width, false, true);
  }
} else {
  await checkIcon(path.join(tauri, 'icons/128x128.png'), 128);
}
console.log(`Verified WonderShine ${platform} icons in build inputs.`);
