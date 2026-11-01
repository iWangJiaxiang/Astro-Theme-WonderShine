import { readFileSync, writeFileSync } from 'node:fs';
import { stableVersion } from './context.mjs';

const version = stableVersion(process.env.STUDIO_VERSION);
for (const file of ['apps/studio/package.json', 'apps/studio/src-tauri/tauri.conf.json']) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  json.version = version;
  if (file.endsWith('tauri.conf.json') && process.env.GITHUB_RUN_NUMBER) {
    const run = Number(process.env.GITHUB_RUN_NUMBER), attempt = Number(process.env.GITHUB_RUN_ATTEMPT || '1');
    if (!Number.isInteger(run) || run < 1 || run > 9999 || !Number.isInteger(attempt) || attempt < 1 || attempt > 99) throw new Error('Invalid iOS build number');
    json.bundle ??= {};
    json.bundle.iOS ??= {};
    json.bundle.iOS.bundleVersion = `${run}.${attempt}`;
  }
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}
const lockFile = 'package-lock.json';
const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
lock.packages['apps/studio'].version = version;
writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
for (const file of ['apps/studio/src-tauri/Cargo.toml', 'apps/studio/src-tauri/Cargo.lock']) {
  const text = readFileSync(file, 'utf8');
  const pattern = /(name = "wondershine-studio"\s+version = ")[^"]+(")/;
  if (!pattern.test(text)) throw new Error(`Studio version not found in ${file}`);
  writeFileSync(file, text.replace(pattern, (_, before, after) => `${before}${version}${after}`));
}
