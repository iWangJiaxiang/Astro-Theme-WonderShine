import type { AiCapabilities, AiImageResult, AiTextRequest } from './ai.js';
import type { TranslationCapabilities, TranslationRequest, TranslationResult } from './translation.js';

export interface NativeAiPreferences { baseUrl: string; model: string; imageModel: string; imageSize: string }
export interface NativeAiConfiguration extends NativeAiPreferences { hasKey: boolean }
export interface NativeAiGateway {
  configuration(): NativeAiConfiguration;
  configure(input: unknown): NativeAiConfiguration;
  clearKey(): NativeAiConfiguration;
  capabilities(): AiCapabilities;
  translationCapabilities(): TranslationCapabilities;
  text(input: AiTextRequest): Promise<{ text: string }>;
  image(input: { prompt: string }): Promise<AiImageResult>;
  translate(input: TranslationRequest): Promise<TranslationResult>;
  dispose(): void;
}
export const imageSizes = ['1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792', 'auto'];
