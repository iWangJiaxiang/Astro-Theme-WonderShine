import type { ImageGenerationSettings } from '../shared/ai.js';
import { inspectTranslationSettings } from './translation-config.js';

export function inspectImageSettings(env: NodeJS.ProcessEnv): ImageGenerationSettings | undefined {
  if (!['STUDIO_AI_IMAGE_MODEL', 'STUDIO_AI_IMAGE_BASE_URL', 'STUDIO_AI_IMAGE_API_KEY', 'STUDIO_AI_IMAGE_SIZE'].some(key => env[key])) return undefined;
  const settings = inspectTranslationSettings({ STUDIO_AI_MODEL: env.STUDIO_AI_IMAGE_MODEL,
    STUDIO_AI_BASE_URL: env.STUDIO_AI_IMAGE_BASE_URL || env.STUDIO_AI_BASE_URL,
    STUDIO_AI_API_KEY: env.STUDIO_AI_IMAGE_API_KEY || env.STUDIO_AI_API_KEY });
  if (!settings) return undefined;
  const size = env.STUDIO_AI_IMAGE_SIZE || (settings.model.startsWith('gpt-image-') ? '1536x1024' : '1024x1024');
  if (!['1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792', 'auto'].includes(size)) throw new Error('AI 图片尺寸配置无效');
  return { ...settings, size };
}
