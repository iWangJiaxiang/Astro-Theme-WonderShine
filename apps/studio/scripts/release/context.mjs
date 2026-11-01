import { readFileSync, appendFileSync } from 'node:fs';

export function stableVersion(value) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error('Use a stable version such as 0.2.0');
  // Tauri Android derives versionCode from these components.
  const [major, minor, patch] = value.split('.').map(Number);
  if (major + minor + patch === 0 || major > 2000 || minor > 99 || patch > 99) throw new Error('Version exceeds mobile version limits (major <= 2000, minor/patch <= 99)');
  return value;
}

export function releaseContext(eventName, event, fallback, sha, uploadTestflight = false) {
  const manual = eventName === 'workflow_dispatch';
  const target = manual ? event.inputs?.target || 'all' : 'all';
  if (!['all', 'ios'].includes(target)) throw new Error('Unsupported Studio distribution target');
  const publish = eventName === 'release' || (manual && String(event.inputs?.publish) === 'true');
  const release = publish && target === 'all';
  const tag = eventName === 'release' ? event.release?.tag_name : '';
  if (eventName === 'release' && (!tag?.startsWith('studio-v') || event.release?.prerelease || event.release?.draft)) throw new Error('Only stable studio-vX.Y.Z releases are supported');
  const version = stableVersion(tag ? tag.slice(8) : (manual && event.inputs?.version) || fallback);
  return { version, tag: `studio-v${version}`, release: String(release), sha, target,
    iosRelease: String(publish), testflight: String(publish && (target === 'ios' || uploadTestflight)) };
}

if (process.argv[1]?.endsWith('/context.mjs')) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const pkg = JSON.parse(readFileSync('apps/studio/package.json', 'utf8'));
  const context = releaseContext(process.env.GITHUB_EVENT_NAME, event, pkg.version, process.env.GITHUB_SHA, process.env.STUDIO_UPLOAD_TESTFLIGHT === 'true');
  for (const [key, value] of Object.entries(context)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}
