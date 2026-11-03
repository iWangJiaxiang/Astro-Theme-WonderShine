import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { navigationMenus } from '../src/lib/navigation';

const defaults = [
  { name: 'Updates', href: '/threads/' },
  { name: 'Timeline', href: '/timeline/' },
];

test('unconfigured activity keeps its default position without mutating data', () => {
  const configured = [{ name: 'Articles' }, { name: 'About', href: '/about' }];
  assert.deepEqual(navigationMenus(configured, defaults), [configured[0], ...defaults, configured[1]]);
  assert.equal(configured.length, 2);
  assert.deepEqual(navigationMenus(configured, []), configured);
  assert.deepEqual(navigationMenus([], defaults), []);
});

test('explicit activity destinations at any depth suppress only their own defaults', () => {
  const configured = [{ name: 'Updates', href: '/threads', menus: [
    { name: 'More', menus: [{ name: 'Timeline', href: '/timeline/?view=all#latest' }] },
  ] }];
  assert.deepEqual(navigationMenus(configured, defaults), configured);
  const partial = [{ name: 'Updates', menus: [{ name: 'All updates', href: '/threads/' }] }];
  assert.deepEqual(navigationMenus(partial, defaults), [...partial, defaults[1]]);
});

test('locale-prefixed destinations suppress defaults but external and detail links do not', () => {
  const configured = [{ name: 'Updates', href: '/en/threads/', menus: [
    { name: 'Timeline', href: '/en/timeline/' },
  ] }];
  assert.deepEqual(navigationMenus(configured, defaults, ['zh-CN', 'en']), configured);
  const unrelated = [{ name: 'External', href: '//example.com/threads/', menus: [
    { name: 'Thread', href: '/threads/example/' },
  ] }];
  assert.deepEqual(navigationMenus(unrelated, defaults), [...unrelated, ...defaults]);
});

test('desktop and mobile consume shared navigation; mobile leaves are links and groups retain main destinations', () => {
  const read = (name: string) => readFileSync(new URL(`../src/components/shell/${name}.astro`, import.meta.url), 'utf8');
  const desktop = read('Navigation'), mobile = read('MobileNavigation');
  for (const source of [desktop, mobile]) {
    assert.match(source, /siteNavigation\(site,lang\)/);
    assert.doesNotMatch(source, /index\s*===\s*0\s*&&/);
  }
  assert.match(mobile, /menu\.menus\?\.length\s*\?/);
  assert.match(mobile, /<details class="drawer-group"><summary>/);
  assert.match(mobile, /: <a class="drawer-link"/);
  assert.match(mobile, /menu\.href&&<a href=\{localizeUrl\(menu\.href,lang,site\)\}/);
  assert.match(desktop, /compact-secondary/);
  assert.match(desktop, /compact-more-panel/);
});
