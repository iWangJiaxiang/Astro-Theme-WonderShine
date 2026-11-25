import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { fixtureAssetPlugin } from './fixture-asset-plugin.mjs';

export async function checkMediaPickerPreview(browser) {
  const fixture = await build({
    plugins: [fixtureAssetPlugin()], loader: { '.css': 'empty' },
    stdin: {
      resolveDir: fileURLToPath(new URL('../../', import.meta.url)), loader: 'tsx', contents: `
import { createRoot } from 'react-dom/client';
import MediaPicker from './src/components/MediaPicker';
import { setMediaPreviewLoader } from './src/media-store';
import { setApiTransport } from './src/api';
import { setMediaResolver } from './shared/media';
const items = Array.from({ length: 25 }, (_, i) => ({
  path: 'public/' + i + '.svg', name: i + '.svg', directory: 'public', mime: 'image/svg+xml', size: 120,
}));
setMediaResolver(() => 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'));
const ready = new Promise(resolve => { window.finishListing = resolve; });
setApiTransport(async (path) => {
  if (path !== '/media') throw new Error('Unexpected request ' + path);
  await ready;
  return Response.json({ items, truncated: false });
});
window.openPicker = previewIndex => {
  setMediaPreviewLoader(async () => ({ items: [items[previewIndex]], truncated: false }));
  createRoot(document.getElementById('root')).render(<MediaPicker mode="public" selected="public/24.svg" documentPath="" svgOnly={false} />);
};
` },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false,
    define: { 'process.env.NODE_ENV': '"development"' },
  });
  for (const scenario of ['missing', 'moved', 'user searching']) {
    const page = await browser.newPage();
    try {
      const previewIndex = scenario === 'moved' ? 24 : 0;
      await page.setContent('<div id="root"></div>');
      await page.addScriptTag({ content: fixture.outputFiles[0].text });
      await page.evaluate(index => window.openPicker(index), previewIndex);
      await page.waitForSelector(`dialog:modal .media-browser[aria-busy=true] [data-media-path="public/${previewIndex}.svg"]`);
      if (scenario === 'user searching') await page.type('.media-search input', '.svg');
      await page.evaluate(() => window.finishListing());
      await page.waitForSelector('.media-browser[aria-busy=false] .media-pagination');
      const expectedPage = scenario === 'user searching' ? '1 / 2' : '2 / 2';
      await page.waitForFunction(expected => document.querySelector('.media-pagination .row small')?.textContent === expected, {}, expectedPage);
      if (scenario !== 'user searching') {
        assert.ok(await page.$('[data-media-path="public/24.svg"]'));
        await page.click('.media-pagination button:first-child');
        await page.waitForSelector('[data-media-path="public/0.svg"]');
      }
      assert.ok(await page.$('.media-dialog .selection-footer button:disabled'), 'locating the stored image does not stage a selection');
    } finally {
      await page.close();
    }
  }
  console.log('PASS: stored image pagination after a partial preview, a reordered listing and manual filtering.');
}
