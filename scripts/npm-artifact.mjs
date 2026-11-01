import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { themeVersion } from './npm-release.mjs';

const packageName = '@wondershine/theme';
export function artifactManifest(bytes, version, repository, source) {
  const parsed = themeVersion(version);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[0-9a-f]{40}$/.test(source)) throw new Error('Invalid artifact source');
  return { package: packageName, version, repository, source, distTag: parsed.distTag,
    filename: `wondershine-theme-${version}.tgz`, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export function verifyArtifact(manifest, bytes, expected) {
  const actual = artifactManifest(bytes, expected.version, expected.repository, expected.source);
  for (const [key, value] of Object.entries(actual)) {
    if (manifest[key] !== value) throw new Error(`Package artifact mismatch: ${key}`);
  }
  return actual;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = themeVersion(process.env.THEME_VERSION).version;
  const repository = process.env.GITHUB_REPOSITORY, source = process.env.GITHUB_SHA;
  const folder = resolve('temp/npm-release'), filename = `wondershine-theme-${version}.tgz`;
  const destination = join(folder, filename);
  if (process.argv[2] === 'prepare') {
    // test-package.mjs copies the exact archive that passed the isolated install/build.
    const tested = resolve('temp', filename), bytes = readFileSync(tested);
    const manifest = artifactManifest(bytes, version, repository, source);
    mkdirSync(folder, { recursive: true });
    copyFileSync(tested, destination);
    writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  } else if (process.argv[2] === 'verify') {
    verifyArtifact(JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')), readFileSync(destination), { version, repository, source });
  } else {
    throw new Error('Expected prepare or verify');
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `archive=${destination}\n`);
  console.log(`Verified package artifact: ${filename}`);
}
