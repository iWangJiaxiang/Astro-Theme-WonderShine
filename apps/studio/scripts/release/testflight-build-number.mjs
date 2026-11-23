import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appStoreConnectClient } from './app-store-connect.mjs';
import { stableVersion } from './context.mjs';

export async function nextTestFlightBuildNumber(get, bundle, version) {
  const apps = await get('apps', { 'filter[bundleId]': bundle, limit: '1' });
  const app = apps.data[0]?.id;
  if (!app) throw new Error('App Store Connect could not find the Studio app');

  let highest = 0;
  async function scan(resource, params, field) {
    let page = await get(resource, { ...params, limit: '200' });
    while (true) {
      for (const item of page.data) {
        const number = item.attributes[field];
        if (typeof number !== 'string' || !/^\d+(?:\.\d+){0,2}$/.test(number)) {
          throw new Error('App Store Connect returned an invalid iOS build number');
        }
        // The next integer after a legacy build such as 299.1 is 300.
        highest = Math.max(highest, Number(number.split('.')[0]));
      }
      if (!page.links?.next) break;
      page = await get(page.links.next);
    }
  }

  await scan('builds', {
    'filter[app]': app,
    'filter[preReleaseVersion.platform]': 'IOS',
    'filter[preReleaseVersion.version]': version,
    'fields[builds]': 'version',
  }, 'version');
  // An accepted upload can be visible here before it appears in the builds list.
  await scan(`apps/${encodeURIComponent(app)}/buildUploads`, {
    'filter[platform]': 'IOS',
    'filter[cfBundleShortVersionString]': version,
    'fields[buildUploads]': 'cfBundleVersion',
  }, 'cfBundleVersion');
  if (highest >= 9999) throw new Error('TestFlight build numbers are exhausted for this Studio version');
  return String(highest + 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { identifier } = JSON.parse(readFileSync('apps/studio/src-tauri/tauri.conf.json', 'utf8'));
  const version = stableVersion(process.env.STUDIO_VERSION);
  const get = appStoreConnectClient({
    id: process.env.APPLE_API_KEY,
    issuer: process.env.APPLE_API_ISSUER,
    pem: Buffer.from(process.env.APPLE_API_KEY_BASE64, 'base64'),
  });
  const build = await nextTestFlightBuildNumber(get, identifier, version);
  appendFileSync(process.env.GITHUB_ENV, `STUDIO_IOS_BUILD_NUMBER=${build}\n`);
  console.log(`Selected TestFlight build ${version} (${build}).`);
}
