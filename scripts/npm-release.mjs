import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function themeVersion(value) {
  if (typeof value !== 'string' || value.trim() !== value) throw new Error('Theme version must be a non-whitespace string');
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(beta|rc|canary)\.(0|[1-9]\d*))?$/.exec(value);
  if (!match) throw new Error('Expected X.Y.Z with an optional -beta.N, -rc.N or -canary.N suffix');
  const channel = match[4];
  return { version: value, prerelease: Boolean(channel), distTag: channel === 'canary' ? 'canary' : channel ? 'next' : 'latest' };
}

export function themeReleaseContext(eventName, event, pkg, repository, sha) {
  if (!['workflow_dispatch', 'repository_dispatch', 'release'].includes(eventName)) throw new Error('Only manual validation and theme releases are supported');
  if (pkg.name !== '@wondershine/theme' || pkg.private) throw new Error('Expected the public @wondershine/theme package');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('Invalid release source');
  const expectedRepository = `https://github.com/${repository}.git`;
  if (pkg.repository?.url?.toLowerCase() !== expectedRepository.toLowerCase()) throw new Error('Package repository must match the publishing repository for provenance');
  const version = themeVersion(pkg.version);
  const tag = `theme-v${version.version}`;
  if (eventName === 'release') {
    if (event.release?.target_commitish !== 'main') throw new Error('Theme Release must target main');
    if (event.release?.draft || event.release?.tag_name !== tag) throw new Error('Release tag must match packages/theme/package.json exactly');
    if (Boolean(event.release.prerelease) !== version.prerelease) throw new Error('GitHub prerelease status must match the package version');
  }
  if (eventName === 'repository_dispatch' && (event.action !== 'theme-canary' || version.distTag !== 'canary' || event.client_payload?.version !== version.version)) {
    throw new Error('Canary dispatch must match the committed main canary version');
  }
  return { ...version, tag, publish: String(eventName !== 'workflow_dispatch'), sha, repository };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const pkg = JSON.parse(readFileSync('packages/theme/package.json', 'utf8'));
  const context = themeReleaseContext(process.env.GITHUB_EVENT_NAME, event, pkg, process.env.GITHUB_REPOSITORY, process.env.GITHUB_SHA);
  for (const [key, value] of Object.entries(context)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log(`${pkg.name}@${context.version}: ${context.publish === 'true' ? 'publish' : 'dry run'} (${context.distTag})`);
}
