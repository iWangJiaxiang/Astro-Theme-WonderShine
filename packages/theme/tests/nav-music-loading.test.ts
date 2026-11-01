import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../assets/js/nav-music.js', import.meta.url), 'utf8');
function harness() {
  const loads: string[] = [];
  let defined = false;
  class Element extends EventTarget {
    isConnected = true;
    _activated = false;
    aplayer: { currentTime: number } | undefined;
    connectedCallback() {
      if (!this._activated) return;
      this.aplayer = { currentTime: 0 };
      this.dispatchEvent(new Event('meting:ready'));
    }
  }
  const element = new Element();
  const window: { APlayer?: object; customElements: { get: () => boolean }; ensureNavMusic?: () => Promise<{ currentTime: number }> } = { customElements: { get: () => defined } };
  runInNewContext(source, {
    window, document: { querySelector: (selector: string) => selector === '#nav-music meting-js' ? element : undefined },
    getCSS: async (url: string) => { loads.push(url); },
    getScript: async (url: string) => { loads.push(url); if (url.includes('APlayer')) window.APlayer = {}; else defined = true; },
    setTimeout, clearTimeout,
  });
  return { window, element, loads };
}

test('navigation music loads only on request, deduplicates clicks and reuses a persisted player', async () => {
  const { window, loads, element } = harness();
  assert.equal(loads.length, 0);
  const first = window.ensureNavMusic!();
  assert.equal(window.ensureNavMusic!(), first);
  const player = await first;
  assert.deepEqual(loads, ['/libs/aplayer/APlayer.min.css', '/libs/aplayer/APlayer.min.js', '/libs/aplayer/Meting2.min.js']);
  player.currentTime = 42;
  assert.equal(await window.ensureNavMusic!(), player);
  assert.equal(element.aplayer?.currentTime, 42);
  assert.equal(loads.length, 3);
});

test('a navigation player removed while libraries load does not start a playlist', async () => {
  const { window, element } = harness();
  const request = window.ensureNavMusic!();
  element.isConnected = false;
  await assert.rejects(request, /removed/);
  assert.equal(element._activated, false);
  assert.equal(element.aplayer, undefined);
});
