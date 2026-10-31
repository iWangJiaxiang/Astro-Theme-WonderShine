import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../assets/js/comment/twikoo.js', import.meta.url), 'utf8');
async function load(lang: string, connected = true, installed = false) {
  const page = { isConnected: connected, dataset: { commentPath: '/thread/example/' } };
  const container = { textContent: '', setAttribute() {} };
  runInNewContext(source, {
    document: { documentElement: { lang }, getElementById: (id: string) => id === 'post-comment' ? page : container },
    location: { pathname: '/thread/example/' },
    GLOBAL_CONFIG: { source: { comments: { lazyload: false }, twikoo: { js: 'https://sdk.invalid/twikoo.js', twikooUrl: 'https://comments.invalid' } } },
    getScript: () => Promise.reject(new Error('Network unavailable')),
    ...(installed ? { twikoo: { init: () => Promise.reject(new Error('Service unavailable')) } } : {}),
    setTimeout,
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  return container.textContent;
}
test('blocked comment SDK displays a Chinese empty state', async () => {
  assert.equal(await load('zh-CN'), '暂时无法加载评论');
});
test('blocked comment SDK displays an English empty state', async () => {
  assert.equal(await load('en'), 'Comments are temporarily unavailable');
});
test('a late failure cannot replace comments after navigation', async () => {
  assert.equal(await load('en', false), '');
});
test('SDK initialization failure is handled too', async () => {
  assert.equal(await load('en', true, true), 'Comments are temporarily unavailable');
});

test('an available SDK initializes once and updates the comment count', async () => {
  let initialized = 0;
  const page = { isConnected: true, dataset: { commentPath: '/thread/example/' } };
  const container = { textContent: '', innerText: '' };
  runInNewContext(source, {
    document: { documentElement: { lang: 'en' }, getElementById: (id: string) => id === 'post-comment' ? page : container },
    location: { pathname: '/thread/example/' },
    GLOBAL_CONFIG: { source: { comments: { lazyload: false }, twikoo: { twikooUrl: 'https://comments.invalid' } } },
    twikoo: {
      init: async (options: { path: string }) => { assert.equal(options.path, '/thread/example/'); initialized++; },
      getCommentsCount: async () => [{ count: 3 }],
    },
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(initialized, 1);
  assert.equal(container.innerText, 3);
  assert.equal(container.textContent, '');
});
