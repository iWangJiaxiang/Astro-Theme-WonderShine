import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function updaterPlatforms(files, directory, platform, base, pubkey) {
  const [os, arch] = platform.split('-');
  const formats = { linux: { AppImage: 'appimage', deb: 'deb', rpm: 'rpm' }, windows: { exe: 'nsis' }, macos: { 'app.tar.gz': 'app' } };
  const result = {};
  for (const [extension, bundle] of Object.entries(formats[os])) {
    const candidates = files.filter(file => file.name.endsWith('.' + extension));
    if (candidates.length !== 1) throw new Error(`Expected one ${extension} updater for ${platform}`);
    const { name } = candidates[0];
    if (!files.some(f => f.name === name + '.sig')) throw new Error(`Missing updater signature for ${name}`);
    const signature = (await readFile(join(directory, name + '.sig'), 'utf8')).trim();
    if (!signature) throw new Error('Empty update signature');
    if (pubkey) {
      const key = packet(pubkey), sig = packet(signature);
      if (key.length !== 42 || sig.length !== 74 || !sig.subarray(2, 10).equals(key.subarray(2, 10))) throw new Error('Updater signing key does not match the embedded public key');
    }
    const target = [os === 'macos' ? 'darwin' : os, arch === 'x64' ? 'x86_64' : 'aarch64', bundle].join('-');
    result[target] = { url: base + name, signature };
  }
  return result;
}

function packet(encoded) {
  const line = Buffer.from(encoded, 'base64').toString('utf8').split(/\r?\n/)[1];
  return Buffer.from(line || '', 'base64');
}
