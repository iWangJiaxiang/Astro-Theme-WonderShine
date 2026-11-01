import { execFileSync } from 'node:child_process';
import { stableVersion } from './context.mjs';

const required = ['ANDROID_KEYSTORE_BASE64', 'ANDROID_STORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD', 'IOS_CERTIFICATE', 'IOS_CERTIFICATE_PASSWORD', 'IOS_MOBILE_PROVISION', 'APPLE_DEVELOPMENT_TEAM'];
if (process.env.STUDIO_UPLOAD_TESTFLIGHT === 'true') required.push('APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_KEY_BASE64');
const missing = required.filter(key => !process.env[key]);
if (missing.length) throw new Error(`Configure GitHub Actions secrets/variables: ${missing.join(', ')}`);
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
console.log('Release configuration is present; signing validity will be checked by platform builders.');
