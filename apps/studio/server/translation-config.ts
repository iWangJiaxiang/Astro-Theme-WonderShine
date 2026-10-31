import type { TranslationSettings } from '../shared/translation.js';

export function inspectTranslationSettings(env: NodeJS.ProcessEnv): TranslationSettings | undefined {
  const values = [env.STUDIO_AI_BASE_URL, env.STUDIO_AI_MODEL, env.STUDIO_AI_API_KEY];
  if (values.every(value => !value)) return undefined;
  if (values.some(value => !value?.trim())) throw new Error('请完整配置 AI 翻译接口、模型和密钥');
  let url: URL;
  try { url = new URL(env.STUDIO_AI_BASE_URL!); } catch { throw new Error('AI 翻译接口地址无效'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('AI 翻译接口地址不能包含凭据、查询参数或片段');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('AI 翻译接口需要 HTTPS，本地服务除外');
  return { baseUrl: url.href.replace(/\/$/, ''), model: env.STUDIO_AI_MODEL!.trim(), apiKey: env.STUDIO_AI_API_KEY!.trim() };
}
