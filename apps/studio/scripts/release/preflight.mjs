import { execFileSync } from 'node:child_process';
import { stableVersion } from './context.mjs';

const version = stableVersion(process.env.STUDIO_VERSION);
const tag = `studio-v${version}`;
const api = path => {
  try { return JSON.parse(execFileSync('gh', ['api', `repos/${process.env.GITHUB_REPOSITORY}/${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })); }
  catch (error) { if (String(error.stderr).includes('HTTP 404')) return null; throw error; }
};
const tagRef = api(`git/ref/tags/${tag}`);
const commit = tagRef ? api(`commits/${tag}`) : null;
if (commit && commit.sha !== process.env.STUDIO_SOURCE) throw new Error('Release tag belongs to another source commit; choose a new version or run from that tag');
const release = api(`releases/tags/${tag}`);
if (release?.assets.some(asset => asset.name === 'studio-release.json')) throw new Error('This Studio release is already complete. Choose a new version.');
if (release?.prerelease) throw new Error('Studio App distribution currently supports stable releases only');
console.log('Release source and version are valid; each platform checks its own signing configuration.');
