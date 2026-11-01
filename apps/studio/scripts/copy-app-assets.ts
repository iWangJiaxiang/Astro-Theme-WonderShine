import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { vditorRoot } from '../server/vendor.js';
const target = resolve('dist/client/vendor/vditor');
await mkdir(target, { recursive: true });
await cp(vditorRoot, target, { recursive: true });
console.log('Bundled Vditor assets for offline app editing.');
