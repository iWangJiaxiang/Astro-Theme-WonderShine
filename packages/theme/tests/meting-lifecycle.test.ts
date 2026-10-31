import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../assets/libs/aplayer/Meting2.min.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

function harness(remote = false) {
  let resolveRequest: (value: unknown) => void = () => {};
  const players: {destroyed: boolean; currentTime: number; destroy: () => void}[] = [];
  const requests: AbortSignal[] = [];
  class Element {
    isConnected = true;
    attributes = remote ? [{name: 'id', value: '123'}] : [{name: 'url', value: '/song.mp3'}];
    innerText = ''; textContent = '';
    appendChild() {}
  }
  class Player {
    destroyed = false; currentTime = 0;
    constructor() { players.push(this); }
    destroy() { this.destroyed = true; }
  }
  const window = {APlayer: Player, fetch: true, customElements: {get() {}, define() {}}, MetingJSElement: undefined as any};
  runInNewContext(source, {window, HTMLElement: Element, APlayer: Player, AbortController, setTimeout, clearTimeout, console,
    document: {createElement: () => ({})}, fetch: (_url: string, options: {signal: AbortSignal}) => {
      requests.push(options?.signal);
      return new Promise(resolve => {resolveRequest = resolve;});
    },
  });
  const element = new window.MetingJSElement();
  return {element, players, requests, respond: async () => {resolveRequest({json: async () => [{url: '/song.mp3'}]}); await tick();}};
}

test('Meting preserves the same player and position through modern and fallback DOM moves', async () => {
  const {element, players} = harness();
  element.connectedCallback();
  const player = element.aplayer; player.currentTime = 42;
  element.connectedMoveCallback();
  element.isConnected = false; element.disconnectedCallback();
  element.isConnected = true; element.connectedCallback();
  await tick();
  assert.equal(element.aplayer, player);
  assert.equal(player.currentTime, 42);
  assert.equal(player.destroyed, false);
  assert.equal(players.length, 1);
  element.isConnected = false; element.disconnectedCallback();
  await tick();
  assert.equal(player.destroyed, true);
  element.isConnected = true; element.connectedCallback();
  assert.equal(players.length, 2);
});

test('Meting keeps a pending playlist through a move but ignores it after permanent removal', async () => {
  const active = harness(true);
  active.element.connectedCallback();
  active.element.isConnected = false; active.element.disconnectedCallback();
  active.element.isConnected = true; active.element.connectedCallback();
  assert.equal(active.requests.length, 1);
  await active.respond();
  assert.equal(active.players.length, 1);

  const removed = harness(true);
  removed.element.connectedCallback();
  removed.element.isConnected = false; removed.element.disconnectedCallback();
  await tick();
  assert.equal(removed.requests[0].aborted, true);
  await removed.respond();
  assert.equal(removed.players.length, 0);
});
