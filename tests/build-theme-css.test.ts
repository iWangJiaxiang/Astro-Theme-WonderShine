import assert from 'node:assert/strict';
import test from 'node:test';
import { buildThemeCss } from '../scripts/build-theme-css.mjs';

test('CSS builds complete all stylesheets', () => {
  const calls: string[][] = [];
  buildThemeCss((_command, args) => {
    calls.push(args);
    return { status: 0 };
  });
  assert.equal(calls.length, 13);
  assert.ok(calls[12].includes('packages/theme/assets/dist/css/404.css'));
});

for (const [label, result, exitCode, diagnostic] of [
  ['nonzero exit', { status: 7 }, 7, /status 7/],
  ['startup failure', { status: null, error: new Error('spawn failed') }, 1, /spawn failed/],
  ['signal termination', { status: null, signal: 'SIGTERM' }, 1, /SIGTERM/],
] as const) {
  test(`CSS builds stop immediately after ${label}`, () => {
    let calls = 0;
    assert.throws(() => buildThemeCss(() => {
      calls++;
      return calls === 1 ? { status: 0 } : result;
    }), (error: Error & { exitCode: number }) => {
      assert.match(error.message, /CSS build failed for fancybox/);
      assert.match(error.message, diagnostic);
      assert.equal(error.exitCode, exitCode);
      return true;
    });
    assert.equal(calls, 2);
  });
}
