import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export function validateIOSSdk(value) {
  const match = /^iphoneos(\d+)(?:\.\d+)*$/.exec(value);
  if (!match || Number(match[1]) < 26) throw new Error('Signed IPA must declare an iPhoneOS SDK of version 26 or later.');
  return value;
}

export function validateIOSExportCompliance(plist) {
  if (plist?.ITSAppUsesNonExemptEncryption !== false) {
    throw new Error('Signed IPA must declare ITSAppUsesNonExemptEncryption as boolean false.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(readFileSync('temp/studio-artifacts/ios.json', 'utf8'));
  const artifact = manifest.files.find(file => /^[\w.-]+\.ipa$/.test(file.name));
  if (!artifact) throw new Error('Missing iOS IPA');
  const ipa = resolve('temp/studio-artifacts', artifact.name);
  const entries = execFileSync('unzip', ['-Z1', ipa], { encoding: 'utf8' }).split('\n');
  const plists = entries.filter(entry => /^Payload\/[^/]+\.app\/Info\.plist$/.test(entry));
  if (plists.length !== 1) throw new Error('Expected one main app Info.plist in the signed IPA');
  const plist = execFileSync('unzip', ['-p', ipa, plists[0]]);
  const metadata = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: plist, encoding: 'utf8' }));
  validateIOSExportCompliance(metadata);
  console.log(`Verified signed IPA SDK: ${validateIOSSdk(metadata.DTSDKName)}`);
  console.log(`Verified signed IPA encryption declaration: false; build ${metadata.CFBundleVersion}`);
}
