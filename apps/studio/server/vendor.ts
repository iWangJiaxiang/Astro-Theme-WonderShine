import { createRequire } from 'node:module';
import { dirname } from 'node:path';
export const vditorRoot = dirname(createRequire(import.meta.url).resolve('vditor/package.json'));
