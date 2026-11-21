import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';

export function stableVersion(value) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error('Use a stable version such as 0.2.0');
  // Tauri Android derives versionCode from these components.
  const [major, minor, patch] = value.split('.').map(Number);
  if (major + minor + patch === 0 || major > 2000 || minor > 99 || patch > 99) throw new Error('Version exceeds mobile version limits (major <= 2000, minor/patch <= 99)');
  return value;
}

function studioPushPaths(before, after) {
  const args = /^0+$/.test(before) ? ['ls-tree', '-r', '--name-only', '-z', after]
    : ['diff', '--name-only', '--no-renames', '-z', before, after];
  return execFileSync('git', [...args, '--', 'apps/studio'], { encoding: 'utf8' }).split('\0');
}

export function releaseContext(eventName, event, fallback, sha, uploadTestflight = false, changedPaths = []) {
  const manual = eventName === 'workflow_dispatch';
  const target = manual ? event.inputs?.target || 'all' : 'all';
  if (!['all', 'ios'].includes(target)) throw new Error('Unsupported Studio distribution target');
  const publish = eventName === 'release' || (manual && String(event.inputs?.publish) === 'true');
  if (manual && publish && event.ref !== 'refs/heads/main') throw new Error('Dispatch Studio publishing from main');
  const autoTestflight = eventName === 'push' && event.ref === 'refs/heads/main' && !event.deleted && uploadTestflight &&
    changedPaths.some(path => path.startsWith('apps/studio/') && !path.endsWith('.md') && !path.includes('/tests/'));
  const release = publish && target === 'all';
  const tag = eventName === 'release' ? event.release?.tag_name : '';
  if (eventName === 'release' && (!tag?.startsWith('studio-v') || event.release?.prerelease || event.release?.draft)) throw new Error('Only stable studio-vX.Y.Z releases are supported');
  const version = stableVersion(tag ? tag.slice(8) : (manual && event.inputs?.version) || fallback);
  return { version, tag: `studio-v${version}`, release: String(release), sha, target,
    iosRelease: String(publish || autoTestflight), testflight: String(autoTestflight || (publish && (target === 'ios' || uploadTestflight))) };
}

if (process.argv[1]?.endsWith('/context.mjs')) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const pkg = JSON.parse(readFileSync('apps/studio/package.json', 'utf8'));
  const { GITHUB_EVENT_NAME: name, GITHUB_REF: ref, GITHUB_SHA: sha } = process.env;
  const uploadTestflight = process.env.STUDIO_UPLOAD_TESTFLIGHT === 'true';
  const paths = name === 'push' && ref === 'refs/heads/main' && !event.deleted && uploadTestflight
    ? studioPushPaths(event.before, sha) : [];
  const context = releaseContext(name, { ...event, ref }, pkg.version, sha, uploadTestflight, paths);
  for (const [key, value] of Object.entries(context)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}
