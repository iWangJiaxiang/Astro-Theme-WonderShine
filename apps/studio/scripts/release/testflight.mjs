import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

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
  const result = spawnSync('xcrun', ['altool', '--upload-app', '--type', 'ios', '--file', resolve('temp/studio-artifacts', ipa.name), '--apiKey', key, '--apiIssuer', process.env.APPLE_API_ISSUER], { cwd: directory, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  // Some altool versions exit zero even when Apple rejects the upload.
  // Keep raw tool output private: it can contain Apple account identifiers.
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const rejected = /UPLOAD FAILED|Failed to upload package|Validation failed|ERROR:/i.test(output);
  const accepted = /UPLOAD SUCCEEDED|No errors uploading|successfully uploaded/i.test(output);
  if (result.error || result.status !== 0 || rejected || !accepted) {
    const reason = /SDK version issue/i.test(output) ? 'Apple rejected the SDK version.'
      : /authentication|unauthorized|invalid.*(?:api|credential)|not authorized/i.test(output) ? 'Apple authentication failed.'
      : /already.*uploaded|duplicate|previously used/i.test(output) ? 'Apple rejected a duplicate build.'
      : 'Apple did not confirm a successful upload.';
    throw new Error(`TestFlight upload failed. ${reason} Raw Apple output is withheld to protect account information.`);
  }
  console.log('Apple confirmed the TestFlight upload. App Store Connect processing is separate.');
} finally { await rm(directory, { recursive: true, force: true }); }
