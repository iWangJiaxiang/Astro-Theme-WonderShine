import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const env = process.env;
let pubkey = env.STUDIO_UPDATER_PUBLIC_KEY;
if (env.STUDIO_RELEASE === 'true') {
  if (!pubkey || !env.TAURI_SIGNING_PRIVATE_KEY) throw new Error('Configure STUDIO_UPDATER_PUBLIC_KEY and TAURI_SIGNING_PRIVATE_KEY for Studio releases.');
} else {
  const key = join(env.RUNNER_TEMP, 'studio-ci-updater');
  const require = createRequire(resolve('apps/studio/package.json'));
  const cli = join(require.resolve('@tauri-apps/cli/package.json'), '..', 'tauri.js');
  execFileSync(process.execPath, [cli, 'signer', 'generate', '--ci', '-w', key], { stdio: 'pipe' });
  pubkey = readFileSync(key + '.pub', 'utf8').trim();
  appendFileSync(env.GITHUB_ENV, `TAURI_SIGNING_PRIVATE_KEY=${key}\n`);
}
const file = 'apps/studio/src-tauri/tauri.conf.json';
const config = JSON.parse(readFileSync(file, 'utf8'));
config.bundle.createUpdaterArtifacts = true;
config.plugins.updater = { pubkey: pubkey.trim(), requireSignedVersion: true };
writeFileSync(file, JSON.stringify(config, null, 2));
