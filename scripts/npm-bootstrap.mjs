import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function assertUnpublishedPackage(status) {
  if (status === 200) throw new Error('Package already exists. Use trusted publishing for subsequent releases.');
  if (status !== 404) throw new Error('Cannot confirm that the package is unpublished; bootstrap refused.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.env.NODE_AUTH_TOKEN) throw new Error('Configure the temporary NPM_BOOTSTRAP_TOKEN GitHub Secret before first publication.');
  const response = await fetch('https://registry.npmjs.org/@wondershine%2ftheme', {
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000),
  });
  await response.body?.cancel();
  assertUnpublishedPackage(response.status);
  console.log('Package is unpublished; first publication is allowed.');
}
