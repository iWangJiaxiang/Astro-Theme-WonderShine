import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAppMetadata } from './verify-ios-sdk.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { appStoreConnectClient } from './app-store-connect.mjs';

// The upload has already succeeded. Query that signed build without changing tester groups.
export async function checkTestFlight(metadata, credentials) {
  const { CFBundleIdentifier: bundle, CFBundleShortVersionString: version, CFBundleVersion: build } = metadata;
  const label = `TestFlight ${version} (${build})`;
  const get = appStoreConnectClient(credentials);
  let appId;
  const deadline = Date.now() + 8 * 60_000;
  while (Date.now() < deadline) {
    let buildRecord, related;
    try {
      if (!appId) {
        const apps = await get('apps', { 'filter[bundleId]': bundle, limit: '1' });
        appId = apps.data[0]?.id;
        if (!appId) { console.log(`${label}: uploaded; this key cannot see the app.`); return; }
      }
      const result = await get('builds', {
        'filter[app]': appId,
        'filter[preReleaseVersion.platform]': 'IOS',
        'filter[preReleaseVersion.version]': version,
        'filter[version]': build,
        include: 'preReleaseVersion,buildBetaDetail',
      });
      related = result.included || [];
      buildRecord = result.data.find(item => item.attributes.version === build && related.some(rel =>
        rel.type === 'preReleaseVersions' && rel.id === item.relationships?.preReleaseVersion?.data?.id && rel.attributes.version === version));
    } catch (error) {
      if (/HTTP 40[13]/.test(error.message)) { console.log(`${label}: uploaded; processing status is unavailable to the upload key.`); return; }
      console.log(`${label}: waiting for App Store Connect status.`);
    }
    if (buildRecord) {
      const state = buildRecord.attributes.processingState;
      if (state === 'FAILED' || state === 'INVALID') throw new Error(`${label}: Apple processing ${state}.`);
      if (state === 'VALID') {
        const beta = related.find(rel => rel.type === 'buildBetaDetails' && rel.id === buildRecord.relationships?.buildBetaDetail?.data?.id);
        console.log(`${label}: Apple processing VALID; internal testing ${beta?.attributes.internalBuildState || 'unreported'}.`);
        return;
      }
    }
    await delay(30_000);
  }
  console.log(`${label}: uploaded; Apple processing has not been confirmed yet.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(await readFile('temp/studio-artifacts/ios.json', 'utf8'));
  const ipa = manifest.files.find(file => /^[\w.-]+\.ipa$/.test(file.name));
  if (!ipa) throw new Error('Missing iOS IPA');
  await checkTestFlight(readAppMetadata(resolve('temp/studio-artifacts', ipa.name)), {
    id: process.env.APPLE_API_KEY, issuer: process.env.APPLE_API_ISSUER,
    pem: Buffer.from(process.env.APPLE_API_KEY_BASE64, 'base64'),
  });
}
