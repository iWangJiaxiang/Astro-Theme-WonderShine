import { AiService } from '../core/ai.js';
import { TranslationService } from '../core/translation.js';
import { StudioError } from '../core/errors.js';
import type { Repository } from '../shared/repository.js';
import type { AiTextRequest } from '../shared/ai.js';
import type { TranslationRequest } from '../shared/translation.js';
import { imageSizes, type NativeAiPreferences, type NativeAiGateway } from '../shared/native-ai.js';

type PreferencesStorage = Pick<Storage, 'getItem' | 'setItem'>;
const empty = (): NativeAiPreferences => ({ baseUrl: '', model: '', imageModel: '', imageSize: '1024x1024' });
function preferences(input: unknown): NativeAiPreferences {
  if (!input || typeof input !== 'object') throw new StudioError(400, '请检查 API 配置');
  const value = input as Record<string, unknown>;
  for (const key of ['baseUrl', 'model', 'imageModel', 'imageSize']) {
    if (typeof value[key] !== 'string' || value[key].length > 2000 || /[\x00-\x1f\x7f]/.test(value[key])) throw new StudioError(400, '请检查 API 配置');
  }
  let url: URL;
  try { url = new URL(String(value.baseUrl).trim()); } catch { throw new StudioError(400, 'API 地址无效'); }
  if (url.username || url.password || url.search || url.hash) throw new StudioError(400, 'API 地址不能包含凭据、查询参数或片段');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new StudioError(400, 'API 需要 HTTPS，本机服务除外');
  const model = String(value.model).trim(), imageModel = String(value.imageModel).trim(), imageSize = String(value.imageSize);
  if ((!model && !imageModel) || model.length > 200 || imageModel.length > 200 || !imageSizes.includes(imageSize)) throw new StudioError(400, '请填写模型并选择有效的图片尺寸');
  return { baseUrl: url.href.replace(/\/+$/, ''), model, imageModel, imageSize };
}

/** App-local settings only. Provider keys are never persisted or returned to the UI. */
export class NativeAiController implements NativeAiGateway {
  private values = empty();
  private key = '';
  private active?: AbortController;
  private disposed = false;
  private storageKey: string;
  constructor(private repository: Repository, private fetcher: typeof fetch, private storage: PreferencesStorage, workspace: string) {
    this.storageKey = 'wondershine.native.ai.v1:' + workspace;
    try { const stored = storage.getItem(this.storageKey); if (stored) this.values = preferences(JSON.parse(stored)); } catch { /* Invalid local preferences are ignored. */ }
  }
  configuration() { return { ...this.values, hasKey: !!this.key }; }
  capabilities() { return { text: !!this.key && !!this.values.model, image: !!this.key && !!this.values.imageModel }; }
  translationCapabilities() { return { enabled: this.capabilities().text, ...(this.capabilities().text ? { model: this.values.model } : {}) }; }
  private writable() {
    if (this.disposed) throw new StudioError(401, '请先连接本地工作区');
    if (this.active) throw new StudioError(409, '正在生成内容，请完成后再修改 API 配置');
  }
  configure(input: unknown) {
    this.writable();
    const next = preferences(input);
    const rawKey = (input as Record<string, unknown>).apiKey;
    if (typeof rawKey !== 'string' || rawKey.length > 8192 || /[\x00-\x1f\x7f]/.test(rawKey)) throw new StudioError(400, 'API Key 格式无效');
    const key = rawKey.trim() || (next.baseUrl === this.values.baseUrl ? this.key : '');
    try { this.storage.setItem(this.storageKey, JSON.stringify(next)); } catch { throw new StudioError(500, '无法保存本机 API 配置，请检查存储空间'); }
    this.values = next; this.key = key;
    return this.configuration();
  }
  clearKey() { this.writable(); this.key = ''; return this.configuration(); }
  dispose() { this.disposed = true; this.active?.abort(); this.key = ''; }
  private async run<T>(work: (fetcher: typeof fetch, signal: AbortSignal) => Promise<T>): Promise<T> {
    this.writable();
    if (!this.key) throw new StudioError(503, '请先在客户端 API 设置中填写 API Key');
    const controller = new AbortController(); this.active = controller;
    const endpoint = this.values.baseUrl;
    const guardedFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (![endpoint + '/chat/completions', endpoint + '/images/generations'].includes(url)) throw new StudioError(400, 'AI 请求超出配置的接口范围');
      const signal = init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
      signal.throwIfAborted();
      const response = await this.fetcher(input, { ...init, signal, redirect: 'error' });
      if (signal.aborted) { await response.body?.cancel(); signal.throwIfAborted(); }
      if (response.redirected || (response.url && response.url !== url)) { await response.body?.cancel(); throw new StudioError(502, 'AI 接口不允许重定向'); }
      return response;
    };
    try { const result = await work(guardedFetch, controller.signal); controller.signal.throwIfAborted(); return result; }
    finally { if (this.active === controller) this.active = undefined; }
  }
  text(input: AiTextRequest) {
    return this.run(fetcher => new AiService(this.values.model ? { baseUrl: this.values.baseUrl, model: this.values.model, apiKey: this.key } : undefined, undefined, fetcher).text(input));
  }
  image(input: { prompt: string }) {
    return this.run(fetcher => new AiService(undefined, this.values.imageModel ? { baseUrl: this.values.baseUrl, model: this.values.imageModel, apiKey: this.key, size: this.values.imageSize } : undefined, fetcher).image(input));
  }
  translate(input: TranslationRequest) {
    return this.run((fetcher, signal) => {
      // Recheck cancellation inside the repository's write guard, after any queue wait.
      const repository = new Proxy(this.repository, { get(target, property) {
        if (property === 'writeBatch') return ((entries, guard) => target.writeBatch(entries, async current => {
          signal.throwIfAborted(); await guard?.(current); signal.throwIfAborted();
        })) satisfies Repository['writeBatch'];
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
      } });
      return new TranslationService(repository, this.values.model ? { baseUrl: this.values.baseUrl, model: this.values.model, apiKey: this.key } : undefined, fetcher).create(input);
    });
  }
}
