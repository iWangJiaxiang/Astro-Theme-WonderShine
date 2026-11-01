import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { stableVersion } from './context.mjs';

const repository = process.env.GITHUB_REPOSITORY;
const version = stableVersion(process.env.STUDIO_VERSION);
const tag = `studio-v${version}`;
const root = 'temp/studio-artifacts';
const expected = ['linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64', 'windows-x64', 'windows-arm64', 'android', 'ios'];
const entries = await readdir(root);
const assets = [];
for (const platform of expected) {
  const manifest = JSON.parse(await readFile(join(root, `${platform}.json`), 'utf8'));
  if (manifest.platform !== platform || manifest.version !== version || manifest.source !== process.env.STUDIO_SOURCE || !manifest.files.length) throw new Error(`Inconsistent ${platform} artifact`);
  for (const file of manifest.files) {
    if (!/^[a-zA-Z0-9._-]+$/.test(file.name) || !entries.includes(file.name)) throw new Error('Unsafe or missing asset');
    const digest = createHash('sha256').update(await readFile(join(root, file.name))).digest('hex');
    if (digest !== file.sha256) throw new Error(`Checksum mismatch: ${file.name}`);
    assets.push({ ...file, platform });
  }
}
const gh = args => execFileSync('gh', [...args, '--repo', repository], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const api = path => {
  try { return JSON.parse(execFileSync('gh', ['api', `repos/${repository}/${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); }
  catch (error) { if (String(error.stderr).includes('HTTP 404')) return null; throw error; }
};
const tagRef = api(`git/ref/tags/${tag}`);
const commit = tagRef ? api(`commits/${tag}`) : null;
if (commit && commit.sha !== process.env.STUDIO_SOURCE) throw new Error('Release tag moved to another source commit');
const existing = api(`releases/tags/${tag}`);
if (existing?.prerelease) throw new Error('Only stable Studio releases are supported');
let release = existing ? { isDraft: existing.draft } : null;
if (release) {
  const details = JSON.parse(gh(['release', 'view', tag, '--json', 'assets']));
  if (details.assets.some(asset => asset.name === 'studio-release.json')) throw new Error('This version is complete and immutable; publish a new version');
} else {
  const notes = 'temp/studio-release-notes.md';
  await writeFile(notes, `WonderShine Studio ${version}\n\nWindows / macOS / Linux / Android 安装包见下方附件。iOS IPA 需要通过 TestFlight / App Store 分发，不能直接安装。\n\n下载前可核对 SHA256SUMS。应用内仅提醒更新，不自动覆盖安装。\n\nSource: ${process.env.STUDIO_SOURCE}\n`);
  gh(['release', 'create', tag, '--target', process.env.STUDIO_SOURCE, '--title', `WonderShine Studio ${version}`, '--notes-file', notes, '--draft']);
  release = { isDraft: true };
}
await writeFile(join(root, 'SHA256SUMS'), assets.map(file => `${file.sha256}  ${file.name}\n`).join(''));
// Incomplete runs may be retried; the completion marker must always be uploaded last.
gh(['release', 'upload', tag, ...assets.map(file => join(root, file.name)), join(root, 'SHA256SUMS'), '--clobber']);
await writeFile(join(root, 'studio-release.json'), JSON.stringify({ schema: 1, version, tag, source: process.env.STUDIO_SOURCE, assets }, null, 2));
gh(['release', 'edit', tag, '--title', `WonderShine Studio ${version}`, ...(release.isDraft ? ['--draft=false', '--latest=false'] : [])]);
gh(['release', 'upload', tag, join(root, 'studio-release.json')]);
console.log(`Published ${tag} with ${assets.length} assets`);
