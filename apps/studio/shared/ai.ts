import type { TranslationSettings } from './translation.js';

export interface ImageGenerationSettings extends TranslationSettings { size: string }
export interface AiCapabilities { text: boolean; image: boolean }
export interface AiTextRequest { task: 'summary' | 'cover-prompt'; title: string; text: string; language: string }
export interface AiImageResult { base64: string; mime: string; extension: string }
