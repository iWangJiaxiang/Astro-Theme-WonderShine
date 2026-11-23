import { sign } from 'node:crypto';

const api = 'https://api.appstoreconnect.apple.com';
const json64 = data => Buffer.from(JSON.stringify(data)).toString('base64url');

export function appStoreConnectClient({ id, issuer, pem }) {
  return async function get(resource, params) {
    const url = params ? new URL('/v1/' + resource, api) : new URL(resource, api);
    if (url.origin !== api) throw new Error('Unexpected App Store Connect pagination URL');
    if (params) url.search = new URLSearchParams(params);
    const now = Math.floor(Date.now() / 1000);
    const header = json64({ alg: 'ES256', kid: id, typ: 'JWT' });
    const claims = json64({ iss: issuer, iat: now, exp: now + 180, aud: 'appstoreconnect-v1' });
    const payload = header + '.' + claims;
    const signature = sign('sha256', Buffer.from(payload), { key: pem, dsaEncoding: 'ieee-p1363' });
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${payload}.${signature.toString('base64url')}` }, redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('App Store Connect status HTTP ' + response.status);
    return response.json();
  };
}
