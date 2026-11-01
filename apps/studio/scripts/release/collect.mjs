import { readdir, mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { basename, join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const platform = process.env.STUDIO_PLATFORM;
if (!/^(linux|windows|macos)-(x64|arm64)$|^(android|ios)$/.test(platform)) throw new Error('Invalid platform');
const output = resolve('temp/studio-artifacts');
await mkdir(output, { recursive: true });
const assets = [];
async function visit(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    const simulator = platform === 'ios' && process.env.STUDIO_RELEASE !== 'true' && entry.isDirectory() && entry.name.endsWith('.app');
    if (simulator) {
      const name = `${platform}-simulator-${process.env.STUDIO_VERSION}.app.tar.gz`;
      if (assets.length) continue;
      execFileSync('tar', ['-czf', join(output, name), '-C', dirname(full), basename(full)]);
      assets.push(name);
    } else if (entry.isDirectory()) {
      await visit(full);
    } else if (entry.isFile() && /\.(deb|rpm|AppImage|dmg|exe|msi|apk|aab|ipa)$/.test(entry.name)) {
      const name = `${platform}-${entry.name.replace(/[^a-zA-Z0-9._-]/g, '-')}`;
      if (assets.includes(name)) throw new Error(`Duplicate release asset: ${name}`);
      await copyFile(full, join(output, name));
      assets.push(name);
    }
  }
}
await visit(process.env.STUDIO_BUNDLE_DIR);
if (!assets.length) throw new Error(`No installable output found for ${platform}`);
if (platform === 'android' && process.env.STUDIO_RELEASE === 'true' && (!assets.some(n => n.endsWith('.apk')) || assets.some(n => /unsigned|debug/.test(n)))) throw new Error('Release requires signed APK outputs');
if (platform === 'ios' && process.env.STUDIO_RELEASE === 'true' && !assets.some(n => n.endsWith('.ipa'))) throw new Error('Release requires an IPA');
const files = await Promise.all(assets.sort().map(async name => ({ name, sha256: createHash('sha256').update(await readFile(join(output, name))).digest('hex') })));
await writeFile(join(output, `${platform}.json`), JSON.stringify({ platform, version: process.env.STUDIO_VERSION, source: process.env.STUDIO_SOURCE, files }, null, 2));
