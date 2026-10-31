import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
export const themeRoot = dirname(createRequire(import.meta.url).resolve('@wondershine/theme/package.json'));
export const themePath = (...parts: string[]) => join(themeRoot, ...parts);
