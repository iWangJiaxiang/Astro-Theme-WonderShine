import assert from 'node:assert/strict';
import test from 'node:test';
import {highlightCode} from '../src/lib/code-highlight';
import {renderMarkdown} from '../src/lib/markdown';

test('code is highlighted during rendering, including aliases and language dependencies', () => {
  assert.match(highlightCode('const value: number = 3;', 'ts'), /class="token keyword"/);
  assert.match(highlightCode('print("Hello")', 'python'), /class="token/);
  assert.match(highlightCode('<script>alert(1)</script>', 'html'), /&lt;/);
  assert.doesNotMatch(highlightCode('<script>alert(1)</script>', 'html'), /<script>/);
});

test('unknown and unsafe language names remain escaped readable code', () => {
  for (const language of ['missing-language', '../../secret', 'constructor', '']) {
    assert.equal(highlightCode('<script>&"', language), '&lt;script&gt;&amp;"');
  }
});

test('Markdown respects the code switch and preserves language and source text', () => {
  const context = {config:{extra:{code:{enable:true}}},document:{path:'/post/',relativePath:'post/index.md',lang:'en'},documentsBySource:new Map()};
  const body='```js\nconst greeting = "Hello";\n```';
  const html=renderMarkdown(body,context).html;
  assert.match(html, /data-lang="js"/);
  assert.match(html, /class="token keyword"/);
  const disabled=renderMarkdown(body,{...context,config:{extra:{code:{enable:false}}}}).html;
  assert.doesNotMatch(disabled, /class="token/);
  assert.match(disabled,/const greeting/);
});
