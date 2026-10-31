import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';
import wondershine from './packages/theme/integration.mjs';
export default defineConfig({integrations:[wondershine({siteRoot:fileURLToPath(new URL('./examples/demo/',import.meta.url))})]});
