import { sign } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

// The upload has already succeeded. Query that signed build without changing tester groups.
export async function checkTestFlight(metadata, credentials) {
  const { CFBundleIdentifier: bundle, CFBundleShortVersionString: version, CFBundleVersion: build } = metadata;
  const label = `TestFlight ${version} (${build})`;
  const json64 = data => Buffer.from(JSON.stringify(data)).toString('base64url');
  async function get(resource, params) {
    const now = Math.floor(Date.now() / 1000);
    const header = json64({ alg: 'ES256', kid: credentials.id, typ: 'JWT' });
    const claims = json64({ iss: credentials.issuer, iat: now, exp: now + 180, aud: 'appstoreconnect-v1' });
    const payload = header + '.' + claims;
    const signature = sign('sha256', Buffer.from(payload), { key: credentials.pem, dsaEncoding: 'ieee-p1363' });
    const response = await fetch('https://api.appstoreconnect.apple.com/v1/' + resource + '?' + new URLSearchParams(params), {
      headers: { Authorization: `Bearer ${payload}.${signature.toString('base64url')}` }, redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('App Store Connect status HTTP ' + response.status);
    return response.json();
  }
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
      const result = await get('builds', { 'filter[app]': appId, 'filter[version]': build, include: 'preReleaseVersion,buildBetaDetail' });
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
