import assert from 'node:assert/strict';
import { test } from 'node:test';
import { overlayPosition } from '../src/overlay-position';

test('popup uses space below its anchor when available', () => {
  assert.deepEqual(overlayPosition({ top: 100, bottom: 144, right: 380 }, { width: 240, height: 180 }, { left: 0, top: 0, width: 390, height: 844 }), { top: 152, left: 140 });
});
test('popup moves above the anchor when the keyboard removes space below', () => {
  assert.deepEqual(overlayPosition({ top: 300, bottom: 344, right: 380 }, { width: 240, height: 180 }, { left: 0, top: 0, width: 390, height: 430 }), { top: 112, left: 140 });
});
test('popup stays inside the panned and magnified visual viewport', () => {
  assert.deepEqual(overlayPosition({ top: 300, bottom: 344, right: 500 }, { width: 180, height: 180 }, { left: 120, top: 200, width: 195, height: 250 }), { top: 208, left: 128 });
});
test('popup below an offscreen anchor still clamps to the panned viewport top', () => {
  assert.deepEqual(overlayPosition({ top: 56, bottom: 100, right: 300 }, { width: 180, height: 160 }, { left: 0, top: 200, width: 390, height: 400 }), { top: 208, left: 120 });
});
test('oversized popup clamps to top/left while CSS supplies its scroll bounds', () => {
  assert.deepEqual(overlayPosition({ top: 0, bottom: 44, right: 100 }, { width: 240, height: 200 }, { left: 0, top: 0, width: 180, height: 160 }), { top: 8, left: 8 });
});
