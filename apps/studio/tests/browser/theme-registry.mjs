// Move the fixture tag after the settings save, before the update check.
const realFetch = globalThis.fetch;
let lookups = 0;
globalThis.fetch = (url, init) => String(url) === 'https://registry.npmjs.org/-/package/@wondershine%2ftheme/dist-tags'
  ? Promise.resolve(Response.json({ canary: lookups++ ? '1.2.3-canary.1' : '1.2.3-canary.0' }))
  : realFetch(url, init);
