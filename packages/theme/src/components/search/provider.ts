/** UI-facing contract; a future local index can implement this without changing the dialog. */
export interface SearchItem { url: string; title: string; section: string; excerpt: string; }
export interface SearchPage { items: SearchItem[]; page: number; pages: number; total: number; }
export interface SearchConfig {
  engine: string;
  meilisearch?: { host?: string; apiKey?: string; indexName?: string };
  algolia?: { appId?: string; apiKey?: string; indexName?: string };
}
export type SearchProvider = (query: string, page: number, signal: AbortSignal) => Promise<SearchPage>;
type RecordData = Record<string, unknown>;
const record = (value: unknown): RecordData => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordData : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const count = (value: unknown, fallback = 0): number => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;

/** Only accept the configured site's URLs; production links also work in local previews. */
export function resultURL(value: unknown, siteURL: string): string | undefined {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u0020\\]/.test(value)) return;
  try {
    const url = new URL(value, siteURL), site = new URL(siteURL);
    if (!['https:', 'http:'].includes(url.protocol) || url.origin !== site.origin || url.username || url.password) return;
    // Never create a protocol-relative URL after removing the origin.
    return `/${url.pathname.replace(/^\/+/, '')}${url.search}${url.hash}`;
  } catch { return; }
}
export function excerpt(value: string, query: string, limit = 180): string {
  const content = value.replace(/\s+/g, ' ').trim();
  const match = content.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  const start = match > 60 ? match - 50 : 0;
  return `${start ? '…' : ''}${content.slice(start, start + limit)}${content.length > start + limit ? '…' : ''}`;
}
export function normalizePage(payload: unknown, engine: string, query: string, page: number, siteURL: string): SearchPage {
  const data = record(payload);
  if (!Array.isArray(data.hits)) throw new Error('Invalid search response');
  const seen = new Set<string>();
  const items: SearchItem[] = [];
  for (const raw of data.hits) {
    const hit = record(raw), hierarchy = record(hit.hierarchy);
    const url = resultURL(hit.url ?? hit.path, siteURL);
    if (!url || seen.has(url)) continue;
    const level = (n: number) => text(hit[`hierarchy_lvl${n}`]) || text(hierarchy[`lvl${n}`]);
    const title = text(hit.title) || level(2) || level(1) || level(0) || excerpt(text(hit.content), '', 80);
    if (!title) continue;
    seen.add(url);
    items.push({url, title, section: [level(3),level(4),level(5)].filter(Boolean).join(' › '), excerpt: excerpt(text(hit.content) || text(hit.description), query)});
  }
  return { items, page, pages: count(engine === 'algolia' ? data.nbPages : data.totalPages), total: count(engine === 'algolia' ? data.nbHits : data.totalHits) };
}

export function createProvider(config: SearchConfig, siteURL: string, request: typeof fetch = fetch): SearchProvider {
  return async (query, page, signal) => {
    let url: string, headers: Record<string, string>, body: RecordData;
    if (config.engine === 'meilisearch') {
      const {host, apiKey, indexName} = config.meilisearch || {};
      if (!host || !indexName) throw new Error('Search is not configured');
      const endpoint = new URL(host);
      if (!['https:', 'http:'].includes(endpoint.protocol)) throw new Error('Invalid search host');
      url = `${host.replace(/\/$/, '')}/indexes/${encodeURIComponent(indexName)}/search`;
      headers = {'Content-Type': 'application/json', ...(apiKey ? {Authorization: `Bearer ${apiKey}`} : {})};
      body = {q: query, page: page + 1, hitsPerPage: 6};
    } else if (config.engine === 'algolia') {
      const {appId, apiKey, indexName} = config.algolia || {};
      if (!appId || !/^[a-z0-9-]+$/i.test(appId) || !apiKey || !indexName) throw new Error('Search is not configured');
      url = `https://${appId}-dsn.algolia.net/1/indexes/${encodeURIComponent(indexName)}/query`;
      headers = {'Content-Type': 'application/json', 'X-Algolia-Application-Id': appId, 'X-Algolia-API-Key': apiKey};
      body = {query, page, hitsPerPage: 6};
    } else { throw new Error('Unsupported search provider'); }
    const response = await request(url, {method: 'POST', headers, body: JSON.stringify(body), signal});
    if (!response.ok) throw new Error(`Search request failed (${response.status})`);
    return normalizePage(await response.json(), config.engine, query, page, siteURL);
  };
}

/** Invalidate immediately on typing, not only when the next debounced request starts. */
export class SearchSession {
  private version = 0;
  private controller?: AbortController;
  constructor(private provider: SearchProvider, private timeout = 10000) {}
  cancel() { this.version++; this.controller?.abort(); }
  async run(query: string, page: number): Promise<SearchPage | undefined> {
    this.cancel();
    const version = this.version, controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Search interrupted')), {once:true}));
      const result = await Promise.race([this.provider(query, page, controller.signal), aborted]);
      return version === this.version ? result : undefined;
    } catch (error) {
      if (version === this.version) throw error;
      return undefined;
    } finally { clearTimeout(timer); }
  }
}
