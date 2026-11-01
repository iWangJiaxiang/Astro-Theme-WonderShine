import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const key = process.env.APPLE_API_KEY;
if (!/^[A-Z0-9]+$/.test(key || '')) throw new Error('Invalid App Store Connect key ID');
const directory = join(process.env.RUNNER_TEMP, 'studio-appstore');
const keyDirectory = join(directory, 'private_keys');
await mkdir(keyDirectory, { recursive: true, mode: 0o700 });
const manifest = JSON.parse(await readFile('temp/studio-artifacts/ios.json', 'utf8'));
const ipa = manifest.files.find(file => /^[\w.-]+\.ipa$/.test(file.name));
if (!ipa) throw new Error('Missing iOS IPA');
try {
  await writeFile(join(keyDirectory, `AuthKey_${key}.p8`), Buffer.from(process.env.APPLE_API_KEY_BASE64, 'base64'), { mode: 0o600 });
  const { resolve } = await import('node:path');
  execFileSync('xcrun', ['altool', '--upload-app', '--type', 'ios', '--file', resolve('temp/studio-artifacts', ipa.name), '--apiKey', key, '--apiIssuer', process.env.APPLE_API_ISSUER], { cwd: directory, stdio: 'inherit' });
} finally { await rm(directory, { recursive: true, force: true }); }
