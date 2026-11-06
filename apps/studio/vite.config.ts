import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(async ({ command }) => {
  const plugins: PluginOption[] = [react()];
  if (process.env.STUDIO_TEST_MEDIA_TRACE === '1') {
    if (process.env.CI !== 'true' || command !== 'build') {
      throw new Error('Media controller tracing requires a CI build');
    }
    // @ts-expect-error The test-only ESM plugin is not part of the application type graph.
    const { mediaDisclosureBuildPlugin } = await import('./tests/browser/media-disclosure-build-plugin.mjs');
    plugins.push(mediaDisclosureBuildPlugin());
  }
  return {
    plugins,
    build: { outDir: 'dist/client', emptyOutDir: true },
    server: { host: '127.0.0.1' },
  };
});
