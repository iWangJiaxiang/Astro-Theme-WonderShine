export interface AppRelease { version: string; url: string }
type ReleaseRecord = { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };

export function releaseRepository(value: string): string {
  if (!/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(value)) throw new Error('Invalid Studio release repository');
  return value;
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error('Invalid stable version');
    const parts = value.split('.').map(Number);
    if (!parts.every(Number.isSafeInteger)) throw new Error('Invalid version');
    return parts;
  };
  const a = parse(left), b = parse(right);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}

export function selectAppRelease(records: unknown, current: string, repository: string): AppRelease | null {
  releaseRepository(repository);
  if (!Array.isArray(records)) throw new Error('Invalid release response');
  let newest: AppRelease | null = null;
  for (const item of records) {
    if (!item || typeof item !== 'object') continue;
    const release = item as ReleaseRecord;
    if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string' || !release.tag_name.startsWith('studio-v')) continue;
    const version = release.tag_name.slice(8);
    const url = `https://github.com/${repository}/releases/tag/${release.tag_name}`;
    if (release.html_url !== url || !Array.isArray(release.assets) || !release.assets.some(asset => asset && typeof asset === 'object' && asset.name === 'studio-release.json' && asset.state === 'uploaded' && asset.size > 0)) continue;
    try {
      if (compareVersions(version, current) > 0 && (!newest || compareVersions(version, newest.version) > 0)) newest = { version, url };
    } catch { /* Ignore unsupported tags without interrupting writing. */ }
  }
  return newest;
}

export async function checkAppRelease(current: string, repository: string, request: typeof fetch, signal: AbortSignal): Promise<AppRelease | null> {
  releaseRepository(repository);
  let newest: AppRelease | null = null;
  // Bounded pagination also handles repositories that publish theme packages more often.
  for (let page = 1; page <= 3; page++) {
    const response = await request(`https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal,
    });
    if (!response.ok) throw new Error(`Update check failed (${response.status})`);
    const records: unknown = await response.json();
    const candidate = selectAppRelease(records, current, repository);
    if (candidate && (!newest || compareVersions(candidate.version, newest.version) > 0)) newest = candidate;
    if (Array.isArray(records) && records.length < 100) break;
  }
  return newest;
}

export function updateDestination(release: AppRelease, repository: string, ios: boolean, storeUrl: string): string {
  const expected = `https://github.com/${releaseRepository(repository)}/releases/tag/studio-v${release.version}`;
  compareVersions(release.version, release.version);
  if (release.url !== expected) throw new Error('Invalid release link');
  if (ios && storeUrl) {
    const url = new URL(storeUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !['apps.apple.com', 'testflight.apple.com'].includes(url.hostname)) throw new Error('Invalid iOS distribution URL');
    return url.href;
  }
  return expected;
}
