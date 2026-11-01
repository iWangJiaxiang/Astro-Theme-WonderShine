import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { browserConfig } from '../src/components/shell/config';
import type { Site } from '../src/lib/types';

const site: Site = {
  root: process.cwd(), config: { title: 'Test', default_language: 'zh-CN' },
  data: {}, localizedData: {}, documents: [], sections: [], languages: ['zh-CN'], defaultLanguage: 'zh-CN', assets: [],
};
const bundle = readFileSync(resolve(import.meta.dirname, '../assets/js/bundle.js'), 'utf8');
const tocSource = bundle.slice(bundle.indexOf('var tocFn = function ()'), bundle.indexOf('// 分类展开'));
const initializerStart = bundle.indexOf("window.initBlogLazy = runOnce('initBlogLazy')");
const initializerEnd = bundle.indexOf("document.addEventListener('DOMContentLoaded'", initializerStart);
const initializerSource = bundle.slice(initializerStart, initializerEnd);

function initializePage(pageType: string, options: { card?: boolean; library?: boolean; headings?: number; abstract?: boolean } = {}) {
  const { card = true, library = true, headings = 2, abstract = true } = options;
  const calls: string[] = [];
  let selector = '';
  const noOp = () => {};
  const runPostAbstract = () => calls.push('abstract');
  const tocContent = { addEventListener: noOp };
  const tocCard = {
    querySelector: () => tocContent,
    getElementsByClassName: () => [tocContent],
    classList: { remove: noOp },
    remove: () => calls.push('remove-toc'),
  };
  const context = {
    GLOBAL_CONFIG: browserConfig(site, 'zh-CN', pageType, 'Chapter'),
    window: { ...(abstract ? { runPostAbstract } : {}) } as { initBlogLazy?: () => void; runPostAbstract?: () => void },
    runOnce: () => (callback: () => void) => callback,
    document: {
      querySelector: () => ({ querySelectorAll: () => Array.from({ length: headings }, () => ({ id: 'heading' })) }),
      getElementById: (id: string) => id === 'card-toc' ? card ? tocCard : null : id === 'rightside' ? { addEventListener: noOp } : null,
    },
    ...(library ? { tocbot: { init: (settings: { contentSelector: string }) => { calls.push('toc'); selector = settings.contentSelector; } } } : {}),
    initializePageWidgets: noOp,
    ...(abstract ? { runPostAbstract } : {}), setPostDate: noOp,
    wjx: { qrcodeCreate: () => calls.push('qrcode') },
    toggleCardCategory: () => calls.push('categories'), setPostDateList: noOp,
    addTableWrap: noOp, clickFnOfTagHide: noOp,
    tabsFn: { clickFnOfTabs: noOp, backToTop: noOp }, jqLoadAndRun: noOp, clickFnOfSubMenu: noOp,
  };
  runInNewContext(tocSource + '\n' + initializerSource, context);
  context.window.initBlogLazy!();
  return { calls, selector, config: context.GLOBAL_CONFIG };
}

test('article and collection reading pages initialize the existing TOC and article interactions', () => {
  for (const type of ['post', 'collection-content', 'collection-detail']) {
    const { calls, selector, config } = initializePage(type);
    assert.equal(config.isPost, true, type);
    assert.equal(config.htmlType, 'post', type);
    assert.deepEqual(calls, ['toc', 'abstract', 'qrcode'], type);
    assert.equal(selector, '.post-content', type);
  }
});

test('collection listings retain listing behavior and do not initialize article TOC', () => {
  for (const type of ['index', 'collection-list', 'collection-category']) {
    const { calls, config } = initializePage(type);
    assert.equal(config.isPost, false, type);
    assert.deepEqual(calls, ['categories'], type);
  }
});

test('reading pages without the optional abstract library still initialize TOC and sharing', () => {
  assert.deepEqual(initializePage('post', { abstract: false }).calls, ['toc', 'qrcode']);
});

test('missing TOC library, omitted widget and heading-free chapters preserve subsequent initialization', () => {
  for (const options of [{ library: false }, { card: false }]) {
    assert.deepEqual(initializePage('collection-content', options).calls, ['abstract', 'qrcode']);
  }
  assert.deepEqual(initializePage('collection-content', { headings: 0 }).calls, ['remove-toc', 'abstract', 'qrcode']);
});

test('theme document classes remain independent from route-specific behavior', () => {
  for (const route of ['index', 'archives', 'taxonomy', 'taxonomy-list', 'about', 'equipment', 'links', 'wechat', 'music', 'collection-list', 'notes', 'timeline', '404']) {
    const config = browserConfig(site, 'zh-CN', route, 'Page');
    assert.equal(config.htmlType, 'page', route);
    assert.equal(config.isHome, route === 'index', route);
    assert.equal(config.isMusic, route === 'music', route);
    assert.equal(config.isPost, false, route);
  }
  for (const route of ['post', 'collection-detail', 'collection-content']) {
    const config = browserConfig(site, 'zh-CN', route, 'Article');
    assert.equal(config.htmlType, 'post', route);
    assert.equal(config.isPost, true, route);
  }
});
