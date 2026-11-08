import test from 'node:test';
import assert from 'node:assert/strict';
import { batch, effect } from '@preact/signals-react';
import { computed, watch, type Ref } from '../src/reactivity';
import { createSessionBoundary, type SessionBoundary, type SessionState } from '../src/session-boundary';

const sample = (id = 'A'): SessionState => ({
  identity: { id, name: 'Editor', method: 'password' }, csrf: 'synthetic', expires: Number.MAX_SAFE_INTEGER,
});
const epochs = (boundary: SessionBoundary) => [boundary.authenticationEpoch, boundary.identityEpoch];
function invalid(action: () => unknown) {
  assert.throws(action, { name: 'TypeError', message: 'Invalid session state' });
}

test('structural ref API, stable proxies, self assignment and copied external aliases', () => {
  const boundary = createSessionBoundary();
  const session: Ref<SessionState | null> = boundary.session;
  assert.equal(session.value, null);
  session.value = null;
  assert.deepEqual(epochs(boundary), [0, 0]);
  const input = sample();
  session.value = input;
  const previousSession = session.value!;
  const previousIdentity = previousSession.identity;
  assert.notEqual(previousSession, input);
  assert.notEqual(previousIdentity, input.identity);
  assert.equal(session.value, previousSession);
  assert.equal(session.value!.identity, previousIdentity);
  session.value = previousSession;
  session.value!.identity = previousIdentity;
  assert.deepEqual(epochs(boundary), [1, 1]);
  input.csrf = 'outside';
  input.identity.id = 'outside';
  assert.equal(previousSession.csrf, 'synthetic');
  assert.equal(previousIdentity.id, 'A');
  assert.deepEqual(epochs(boundary), [1, 1]);
  // App's saved previousSession equality check remains stable until replacement.
  assert.equal(session.value === previousSession, true);
  session.value = sample();
  assert.equal(session.value === previousSession, false);
  assert.deepEqual(epochs(boundary), [2, 1]);
});

test('plain authority records every batched session and field roundtrip synchronously', () => {
  const boundary = createSessionBoundary();
  const { session } = boundary;
  session.value = sample();
  const original = session.value!;
  batch(() => {
    session.value = sample('B');
    assert.deepEqual(epochs(boundary), [2, 2]);
    session.value = original;
    assert.deepEqual(epochs(boundary), [3, 3]);
    assert.notEqual(session.value, original, 'detached proxies are copied, never reactivated');
    session.value = null;
    assert.deepEqual(epochs(boundary), [4, 4]);
    session.value = original;
    assert.deepEqual(epochs(boundary), [5, 5]);
    const current = session.value!;
    current.identity.id = 'B';
    assert.deepEqual(epochs(boundary), [6, 6]);
    current.identity.id = 'A';
    assert.deepEqual(epochs(boundary), [7, 7]);
    current.identity.method = 'oidc';
    assert.deepEqual(epochs(boundary), [8, 8]);
    current.identity.method = 'password';
    assert.deepEqual(epochs(boundary), [9, 9]);
    current.csrf = 'next';
    assert.deepEqual(epochs(boundary), [10, 9]);
    current.csrf = 'synthetic';
    assert.deepEqual(epochs(boundary), [11, 9]);
    current.expires = -1;
    assert.deepEqual(epochs(boundary), [12, 9]);
    current.expires = Number.MAX_SAFE_INTEGER;
    assert.deepEqual(epochs(boundary), [13, 9]);
    current.identity.name = 'Renamed';
    current.csrf = current.csrf;
    current.expires = current.expires;
    current.identity.id = current.identity.id;
    current.identity.method = current.identity.method;
    assert.deepEqual(epochs(boundary), [13, 9]);
  });
  assert.deepEqual(epochs(boundary), [13, 9]);
});

test('identity replacement is an auth boundary; detached identities and sessions cannot notify or own state', () => {
  let invalidations = 0, notifications = 0;
  const boundary = createSessionBoundary({ invalidate: () => { invalidations++; } });
  boundary.session.value = sample();
  const stop = watch(() => boundary.authenticationEpoch, () => { notifications++; });
  const current = boundary.session.value!;
  const oldIdentity = current.identity;
  const input = { ...oldIdentity };
  current.identity = input;
  assert.notEqual(current.identity, input);
  assert.notEqual(current.identity, oldIdentity);
  assert.deepEqual(epochs(boundary), [2, 1]);
  oldIdentity.id = 'detached';
  oldIdentity.name = 'Detached';
  input.method = 'oidc';
  assert.equal(current.identity.id, 'A');
  assert.equal(current.identity.method, 'password');
  assert.equal(invalidations, 2);
  assert.equal(notifications, 1);
  current.identity = oldIdentity;
  assert.notEqual(current.identity, oldIdentity);
  assert.equal(current.identity.id, 'detached');
  assert.deepEqual(epochs(boundary), [3, 2]);
  boundary.session.value = sample('B');
  const before = epochs(boundary);
  const beforeInvalidations = invalidations, beforeNotifications = notifications;
  current.csrf = 'detached';
  current.expires = 0;
  current.identity.id = 'C';
  current.identity = { id: 'D', name: 'Snapshot', method: 'oidc' };
  assert.deepEqual(epochs(boundary), before);
  assert.equal(invalidations, beforeInvalidations);
  assert.equal(notifications, beforeNotifications);
  boundary.session.value = current;
  assert.notEqual(boundary.session.value, current);
  assert.equal(boundary.session.value!.identity.id, 'D');
  current.identity.id = 'E';
  assert.equal(boundary.session.value!.identity.id, 'D');
  stop();
});

test('descriptors, entries and spread expose only owned identity proxies', () => {
  const boundary = createSessionBoundary();
  boundary.session.value = sample();
  const current = boundary.session.value!;
  const identity = current.identity;
  assert.equal(Object.getOwnPropertyDescriptor(current, 'identity')!.value, identity);
  assert.equal(Object.getOwnPropertyDescriptors(current).identity.value, identity);
  assert.equal(Object.fromEntries(Object.entries(current)).identity, identity);
  assert.equal({ ...current }.identity, identity);
  const spread = { ...current };
  spread.identity.id = 'B';
  assert.equal(current.identity.id, 'B');
  assert.deepEqual(epochs(boundary), [2, 2]);
  const copied = { ...identity };
  copied.id = 'external';
  assert.equal(current.identity.id, 'B');
});

test('strict data schema rejects without invoking accessors, changing state or publishing', () => {
  let reads = 0, invalidations = 0, notifications = 0;
  const boundary = createSessionBoundary({ invalidate: () => { invalidations++; } });
  boundary.session.value = sample();
  const before = boundary.session.value;
  const stop = watch(() => JSON.stringify(boundary.session.value), () => { notifications++; });
  const invalidInputs: unknown[] = [
    undefined, false, 1, 'private-input', [], {},
    { ...sample(), extra: 'private-input' },
    { ...sample(), [Symbol('private-input')]: true },
    Object.assign(Object.create({}), sample()),
    Object.defineProperty(sample(), 'csrf', { get() { reads++; return 'private-input'; } }),
    { ...sample(), identity: Object.defineProperty({ ...sample().identity }, 'id', { get() { reads++; return 'private-input'; } }) },
    { ...sample(), identity: { ...sample().identity, extra: true } },
    { ...sample(), identity: { ...sample().identity, [Symbol('private-input')]: true } },
    { ...sample(), identity: Object.assign(Object.create({}), sample().identity) },
    { ...sample(), identity: { ...sample().identity, id: 1 } },
    { ...sample(), identity: { ...sample().identity, name: null } },
    { ...sample(), identity: { ...sample().identity, method: 'native' } },
    { ...sample(), csrf: null },
    ...[NaN, Infinity, -Infinity, '123'].map(expires => ({ ...sample(), expires })),
    JSON.parse('{"identity":{"id":"A","name":"Editor","method":"password"},"csrf":"x","expires":1,"__proto__":{}}'),
    { ...sample(), identity: JSON.parse('{"id":"A","name":"Editor","method":"password","__proto__":{}}') },
  ];
  for (const input of invalidInputs) {
    invalid(() => { boundary.session.value = input as SessionState; });
    assert.equal(boundary.session.value, before);
    assert.deepEqual(epochs(boundary), [1, 1]);
  }
  invalid(() => { boundary.session.value!.identity = { ...sample().identity, method: 'invalid' } as never; });
  invalid(() => { boundary.session.value!.csrf = 1 as never; });
  invalid(() => { boundary.session.value!.expires = Infinity; });
  invalid(() => { boundary.session.value!.identity.name = null as never; });
  invalid(() => { boundary.session.value!.identity.id = null as never; });
  invalid(() => { boundary.session.value!.identity.method = 'invalid' as never; });
  assert.equal(reads, 0);
  assert.equal(invalidations, 1);
  assert.equal(notifications, 0);
  assert.deepEqual(epochs(boundary), [1, 1]);
  stop();
});

test('null-prototype data records and finite expires are accepted without an expiration policy', () => {
  const boundary = createSessionBoundary();
  const data = Object.assign(Object.create(null), sample());
  data.identity = Object.assign(Object.create(null), data.identity);
  boundary.session.value = data;
  for (const expires of [Number.MAX_SAFE_INTEGER, Number.MAX_VALUE, -1, 0, 0.5]) {
    boundary.session.value!.expires = expires;
    assert.equal(boundary.session.value!.expires, expires);
  }
  boundary.session.value!.csrf = '';
  boundary.session.value!.identity.id = '';
  boundary.session.value!.identity.name = '';
  assert.equal(boundary.session.value!.identity.id, '');
});

test('reflection cannot replace fields, poison prototypes, seal or freeze owned records', () => {
  const boundary = createSessionBoundary();
  boundary.session.value = sample();
  for (const target of [boundary.session.value!, boundary.session.value!.identity]) {
    const key = target === boundary.session.value ? 'csrf' : 'id';
    invalid(() => Object.defineProperty(target, key, { value: 'private-input' }));
    invalid(() => Reflect.defineProperty(target, 'extra', { value: true }));
    invalid(() => Reflect.deleteProperty(target, key));
    invalid(() => Object.setPrototypeOf(target, null));
    invalid(() => Object.preventExtensions(target));
    invalid(() => Object.freeze(target));
    invalid(() => Object.seal(target));
    invalid(() => Reflect.set(target, '__proto__', {}));
    invalid(() => Reflect.set(target, Symbol('private-input'), true));
    assert.equal(Object.isExtensible(target), true);
  }
  const descriptor = Object.getOwnPropertyDescriptor(boundary.session, 'value')!;
  assert.equal(descriptor.configurable, false);
  assert.equal(Reflect.deleteProperty(boundary.session, 'value'), false);
  assert.equal(Reflect.defineProperty(boundary.session, 'value', { value: null }), false);
  assert.throws(() => Object.defineProperty(boundary.session, 'value', { get: () => null }), TypeError);
  assert.equal(Reflect.setPrototypeOf(boundary.session, null), false);
  assert.equal(Reflect.set(boundary.session, 'extra', true), false);
  assert.equal(boundary.session.value!.identity.id, 'A');
  assert.deepEqual(epochs(boundary), [1, 1]);
});

test('real watch/computed track active scalar, name, descriptor and epoch reads', () => {
  const boundary = createSessionBoundary();
  boundary.session.value = sample();
  const current = boundary.session.value!;
  const identity = current.identity;
  const label = computed(() => `${identity.name}:${current.csrf}`);
  const observed: string[] = [];
  const descriptorNames: string[] = [];
  const authority: number[] = [];
  const stops = [
    watch(label, value => observed.push(value)),
    watch(() => Object.getOwnPropertyDescriptor(identity, 'name')!.value as string, value => descriptorNames.push(value)),
    watch(() => boundary.authenticationEpoch, value => authority.push(value)),
  ];
  current.identity.name = 'Renamed';
  assert.equal(label.value, 'Renamed:synthetic');
  assert.deepEqual(observed, ['Renamed:synthetic']);
  assert.deepEqual(descriptorNames, ['Renamed']);
  assert.deepEqual(epochs(boundary), [1, 1]);
  batch(() => {
    current.csrf = 'next';
    current.csrf = 'synthetic';
    assert.equal(boundary.authenticationEpoch, 3);
  });
  assert.deepEqual(authority, [3], 'coalesced publication must retain both boundaries');
  assert.equal(label.value, 'Renamed:synthetic');
  const before = observed.length;
  boundary.session.value = sample('B');
  identity.name = 'Detached';
  current.csrf = 'detached';
  assert.equal(observed.length, before, 'detached writes do not publish');
  for (const stop of stops) stop();
});

test('signal effects subscribe through the single publication revision', () => {
  const boundary = createSessionBoundary();
  const renders: string[] = [];
  const stop = effect(() => {
    renders.push(`${boundary.session.value?.identity.name ?? 'none'}:${boundary.identityEpoch}`);
  });
  boundary.session.value = sample();
  boundary.session.value!.identity.name = 'Renamed';
  batch(() => {
    boundary.session.value = sample('B');
    boundary.session.value = sample();
    assert.deepEqual(epochs(boundary), [3, 3]);
  });
  assert.deepEqual(renders, ['none:0', 'Editor:1', 'Renamed:1', 'Editor:3']);
  stop();
});

test('Object.assign commits each field and leaves earlier valid writes on a later failure', () => {
  const seen: number[][] = [];
  let boundary: SessionBoundary;
  boundary = createSessionBoundary({ invalidate: () => { seen.push(epochs(boundary)); } });
  boundary.session.value = sample();
  invalid(() => Object.assign(boundary.session.value!, { csrf: 'next', expires: Infinity }));
  assert.equal(boundary.session.value!.csrf, 'next');
  assert.equal(boundary.session.value!.expires, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(seen, [[1, 1], [2, 1]]);
});

test('invalidation reentry sees committed authority and cannot be overwritten by outer publication', () => {
  const seen: Array<{ epochs: number[]; id: string | undefined }> = [];
  let boundary: SessionBoundary;
  let reenter = false;
  boundary = createSessionBoundary({ invalidate: () => {
    seen.push({ epochs: epochs(boundary), id: boundary.session.value?.identity.id });
    if (reenter) {
      reenter = false;
      boundary.session.value = sample('C');
    }
  } });
  boundary.session.value = sample();
  const published: Array<{ epochs: number[]; id: string | undefined }> = [];
  const stop = watch(() => boundary.authenticationEpoch, () => {
    published.push({ epochs: epochs(boundary), id: boundary.session.value?.identity.id });
  });
  reenter = true;
  boundary.session.value = sample('B');
  assert.deepEqual(seen, [
    { epochs: [1, 1], id: 'A' }, { epochs: [2, 2], id: 'B' }, { epochs: [3, 3], id: 'C' },
  ]);
  assert.deepEqual(published, [{ epochs: [3, 3], id: 'C' }]);
  assert.equal(boundary.session.value!.identity.id, 'C');
  assert.deepEqual(epochs(boundary), [3, 3]);
  stop();
});

test('abort-listener reentry observes new counters and commits the final owner', () => {
  let boundary: SessionBoundary;
  let controller = new AbortController();
  boundary = createSessionBoundary({ invalidate: () => {
    const previous = controller;
    controller = new AbortController();
    previous.abort();
  } });
  boundary.session.value = sample();
  let listenerCalls = 0;
  controller.signal.addEventListener('abort', () => {
    listenerCalls++;
    assert.equal(boundary.session.value!.identity.id, 'B');
    assert.deepEqual(epochs(boundary), [2, 2]);
    boundary.session.value = sample('C');
  }, { once: true });
  boundary.session.value = sample('B');
  assert.equal(listenerCalls, 1);
  assert.equal(boundary.session.value!.identity.id, 'C');
  assert.deepEqual(epochs(boundary), [3, 3]);
});

test('hook and notification exceptions never roll back committed state', () => {
  const failure = new Error('synthetic hook failure');
  let fail = true;
  const boundary = createSessionBoundary({ invalidate: () => { if (fail) throw failure; } });
  let publications = 0;
  const stop = watch(() => boundary.authenticationEpoch, () => { publications++; });
  assert.throws(() => { boundary.session.value = sample(); }, error => error === failure);
  assert.equal(boundary.session.value!.identity.id, 'A');
  assert.deepEqual(epochs(boundary), [1, 1]);
  assert.equal(publications, 1);
  fail = false;
  const stopThrowing = watch(() => boundary.authenticationEpoch, () => { throw failure; });
  assert.throws(() => { boundary.session.value = sample('B'); }, error => error === failure);
  assert.equal(boundary.session.value!.identity.id, 'B');
  assert.deepEqual(epochs(boundary), [2, 2]);
  stopThrowing();
  stop();
});

test('a throwing outer invalidation cannot overwrite a nested committed owner', () => {
  const failure = new Error('synthetic outer failure');
  let boundary: SessionBoundary;
  let armed = false;
  boundary = createSessionBoundary({ invalidate: () => {
    if (!armed) return;
    armed = false;
    boundary.session.value = sample('C');
    throw failure;
  } });
  boundary.session.value = sample();
  const published: number[] = [];
  const stop = watch(() => boundary.authenticationEpoch, value => published.push(value));
  armed = true;
  assert.throws(() => { boundary.session.value = sample('B'); }, error => error === failure);
  assert.equal(boundary.session.value!.identity.id, 'C');
  assert.deepEqual(epochs(boundary), [3, 3]);
  assert.deepEqual(published, [3]);
  stop();
});

test('notification reentry publishes the newest commit without rolling authority backwards', () => {
  const boundary = createSessionBoundary();
  boundary.session.value = sample();
  const observed: number[] = [];
  let reentered = false;
  const stop = watch(() => boundary.authenticationEpoch, value => {
    observed.push(value);
    if (!reentered) {
      reentered = true;
      boundary.session.value = sample('C');
      assert.deepEqual(epochs(boundary), [3, 3]);
    }
  });
  boundary.session.value = sample('B');
  assert.equal(boundary.session.value!.identity.id, 'C');
  assert.deepEqual(epochs(boundary), [3, 3]);
  assert.deepEqual(observed, [2, 3]);
  stop();
});

test('direct and App-style multi-source watches distinguish replacements from stable in-place records', () => {
  const boundary = createSessionBoundary();
  const { session } = boundary;
  type Snapshot = readonly [SessionState | null, string | undefined, string | undefined, string | undefined, number | undefined];
  const direct: Array<{ next: SessionState | null; previous: SessionState | null }> = [];
  const multiple: Array<{ next: Snapshot; previous: Snapshot }> = [];
  const stops = [
    watch(session, (next, previous) => { direct.push({ next, previous }); }),
    watch([
      session,
      () => session.value?.identity.id,
      () => session.value?.identity.method,
      () => session.value?.csrf,
      () => session.value?.expires,
    ] as const, (next, previous) => { multiple.push({ next, previous }); }),
  ];
  session.value = sample();
  const current = session.value!;
  const identity = current.identity;
  assert.equal(direct.length, 1);
  assert.equal(multiple.length, 1);
  current.identity.name = 'Renamed';
  assert.equal(direct.length, 1);
  assert.equal(multiple.length, 1, 'name is not one of the App-style watch sources');
  current.csrf = 'next';
  assert.equal(multiple.length, 2);
  current.identity.id = 'B';
  assert.equal(multiple.length, 3);
  current.identity.method = 'oidc';
  assert.equal(multiple.length, 4);
  current.expires = 123;
  assert.equal(multiple.length, 5);
  assert.equal(session.value, current);
  assert.equal(current.identity, identity);
  assert.equal(direct.length, 1, 'direct watch compares the stable session reference');
  current.identity = { ...current.identity };
  assert.notEqual(current.identity, identity);
  assert.equal(multiple.length, 5, 'same scalar sources and session reference do not trigger a callback');
  session.value = { identity: { ...current.identity }, csrf: current.csrf, expires: current.expires };
  const replacement = session.value!;
  assert.notEqual(replacement, current);
  assert.equal(direct.length, 2);
  assert.equal(multiple.length, 6, 'replacement notifies even when all scalar sources match');
  session.value = replacement;
  assert.equal(direct.length, 2);
  assert.equal(multiple.length, 6);
  session.value = null;
  assert.deepEqual(direct, [
    { next: current, previous: null },
    { next: replacement, previous: current },
    { next: null, previous: replacement },
  ]);
  assert.equal(direct[0].next, current);
  assert.equal(direct[0].previous, null);
  assert.equal(direct[1].next, replacement);
  assert.equal(direct[1].previous, current);
  assert.equal(direct[2].next, null);
  assert.equal(direct[2].previous, replacement);
  const empty = [undefined, undefined, undefined, undefined];
  const fields = [
    ['A', 'password', 'synthetic', Number.MAX_SAFE_INTEGER],
    ['A', 'password', 'next', Number.MAX_SAFE_INTEGER],
    ['B', 'password', 'next', Number.MAX_SAFE_INTEGER],
    ['B', 'oidc', 'next', Number.MAX_SAFE_INTEGER],
    ['B', 'oidc', 'next', 123],
    ['B', 'oidc', 'next', 123],
    empty,
  ];
  assert.deepEqual(multiple.map(({ next }) => next.slice(1)), fields);
  assert.deepEqual(multiple.map(({ previous }) => previous.slice(1)), [empty, ...fields.slice(0, -1)]);
  for (let index = 0; index < multiple.length; index++) {
    assert.equal(multiple[index].next[0], index < 5 ? current : index === 5 ? replacement : null);
    assert.equal(multiple[index].previous[0], index === 0 ? null : index < 6 ? current : replacement);
  }
  for (const stop of stops) stop();
});

test('descriptor normalization reentry can detach the outer identity setter without publishing its snapshot write', () => {
  let invalidations = 0;
  const boundary = createSessionBoundary({ invalidate: () => { invalidations++; } });
  boundary.session.value = sample();
  const detached = boundary.session.value!;
  const oldIdentity = detached.identity;
  const published: number[] = [];
  const stop = watch(() => boundary.authenticationEpoch, value => published.push(value));
  const descriptorKeys: PropertyKey[] = [];
  let reentered = false;
  const input = new Proxy(sample('B').identity, {
    getOwnPropertyDescriptor(target, key) {
      descriptorKeys.push(key);
      if (key === 'id' && !reentered) {
        reentered = true;
        boundary.session.value = sample('C');
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  detached.identity = input;
  assert.deepEqual(descriptorKeys, ['id', 'name', 'method']);
  assert.equal(reentered, true);
  assert.notEqual(boundary.session.value, detached);
  assert.equal(boundary.session.value!.identity.id, 'C');
  assert.notEqual(detached.identity, oldIdentity);
  assert.notEqual(detached.identity, input);
  assert.equal(detached.identity.id, 'B');
  assert.equal(oldIdentity.id, 'A');
  assert.deepEqual(epochs(boundary), [2, 2]);
  assert.equal(invalidations, 2, 'only the initial and nested active session commits invalidate');
  assert.deepEqual(published, [2], 'the outer write belongs only to the detached snapshot');
  stop();
});

test('descriptor normalization reentry compares the outer identity with the latest identity for epoch counts', () => {
  for (const outerId of ['A', 'B']) {
    let invalidations = 0;
    const boundary = createSessionBoundary({ invalidate: () => { invalidations++; } });
    boundary.session.value = sample();
    const current = boundary.session.value!;
    const oldIdentity = current.identity;
    let nestedIdentity: SessionState['identity'] | undefined;
    const published: number[][] = [];
    const stop = watch(() => boundary.authenticationEpoch, () => { published.push(epochs(boundary)); });
    const descriptorKeys: PropertyKey[] = [];
    let reentered = false;
    const input = new Proxy(sample(outerId).identity, {
      getOwnPropertyDescriptor(target, key) {
        descriptorKeys.push(key);
        if (key === 'id' && !reentered) {
          reentered = true;
          current.identity = sample('B').identity;
          nestedIdentity = current.identity;
          assert.deepEqual(epochs(boundary), [2, 2]);
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    current.identity = input;
    const expectedIdentityEpoch = outerId === 'A' ? 3 : 2;
    assert.deepEqual(descriptorKeys, ['id', 'name', 'method']);
    assert.equal(reentered, true);
    assert.equal(boundary.session.value, current);
    assert.notEqual(current.identity, oldIdentity);
    assert.notEqual(current.identity, nestedIdentity);
    assert.notEqual(current.identity, input);
    assert.equal(oldIdentity.id, 'A');
    assert.equal(nestedIdentity!.id, 'B');
    assert.equal(current.identity.id, outerId);
    assert.deepEqual(epochs(boundary), [3, expectedIdentityEpoch]);
    assert.equal(invalidations, 3);
    assert.deepEqual(published, [[2, 2], [3, expectedIdentityEpoch]]);
    stop();
  }
});

test('illegal input descriptors fail without rolling back an independent commit made by their trap', () => {
  let invalidations = 0, accessorReads = 0;
  const boundary = createSessionBoundary({ invalidate: () => { invalidations++; } });
  boundary.session.value = sample();
  const detached = boundary.session.value!;
  const oldIdentity = detached.identity;
  const published: number[] = [];
  const stop = watch(() => boundary.authenticationEpoch, value => published.push(value));
  const descriptorKeys: PropertyKey[] = [];
  let reentered = false;
  // A finite Proxy trap may execute JS; descriptor normalization is not a sandbox.
  const input = new Proxy(sample('B').identity, {
    getOwnPropertyDescriptor(target, key) {
      descriptorKeys.push(key);
      if (key === 'id' && !reentered) {
        reentered = true;
        boundary.session.value = sample('C');
        return { configurable: true, enumerable: true, get() { accessorReads++; return 'B'; } };
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  invalid(() => { detached.identity = input; });
  assert.equal(reentered, true);
  assert.deepEqual(descriptorKeys, ['id']);
  assert.equal(accessorReads, 0);
  assert.notEqual(boundary.session.value, detached);
  assert.equal(boundary.session.value!.identity.id, 'C');
  assert.equal(detached.identity, oldIdentity, 'failed normalization never writes the outer target');
  assert.equal(oldIdentity.id, 'A');
  assert.deepEqual(epochs(boundary), [2, 2]);
  assert.equal(invalidations, 2);
  assert.deepEqual(published, [2]);
  stop();
});

test('session-reading effects receive no notifications from detached sessions or old identities', () => {
  const boundary = createSessionBoundary();
  boundary.session.value = sample();
  const current = boundary.session.value!;
  const oldIdentity = current.identity;
  const renders: Array<SessionState | null> = [];
  const stop = effect(() => { renders.push(boundary.session.value); });
  assert.equal(renders.length, 1);
  current.identity = { ...oldIdentity };
  assert.equal(renders.length, 2, 'an active identity replacement publishes even with the same session reference');
  const beforeIdentityWrites = epochs(boundary);
  oldIdentity.id = 'detached-id';
  oldIdentity.name = 'Detached';
  oldIdentity.method = 'oidc';
  assert.equal(renders.length, 2);
  assert.deepEqual(epochs(boundary), beforeIdentityWrites);
  assert.equal(current.identity.id, 'A');
  boundary.session.value = sample('B');
  const replacement = boundary.session.value!;
  assert.equal(renders.length, 3);
  const beforeSessionWrites = epochs(boundary);
  current.csrf = 'detached-csrf';
  current.expires = 0;
  current.identity.id = 'detached-current-id';
  current.identity = sample('D').identity;
  oldIdentity.id = 'detached-again';
  assert.equal(renders.length, 3);
  assert.deepEqual(epochs(boundary), beforeSessionWrites);
  assert.equal(boundary.session.value, replacement);
  assert.equal(replacement.identity.id, 'B');
  assert.equal(replacement.csrf, 'synthetic');
  assert.equal(replacement.expires, Number.MAX_SAFE_INTEGER);
  replacement.csrf = 'active-csrf';
  assert.deepEqual(renders, [current, current, replacement, replacement], 'the effect remains subscribed to active writes');
  assert.deepEqual(epochs(boundary), [4, 2]);
  stop();
});

test('rejected freeze, seal and preventExtensions leave normal id and csrf writes reactive', () => {
  for (const reject of [Object.freeze, Object.seal, Object.preventExtensions]) {
    let invalidations = 0;
    const boundary = createSessionBoundary({ invalidate: () => { invalidations++; } });
    boundary.session.value = sample();
    const current = boundary.session.value!;
    const identity = current.identity;
    const observed: string[] = [];
    const stop = watch(() => `${boundary.session.value!.identity.id}:${boundary.session.value!.csrf}`, value => observed.push(value));
    for (const target of [current, identity]) {
      invalid(() => reject(target));
      assert.equal(Object.isExtensible(target), true);
    }
    assert.equal(boundary.session.value, current);
    assert.equal(current.identity, identity);
    assert.deepEqual(epochs(boundary), [1, 1]);
    assert.equal(invalidations, 1);
    assert.deepEqual(observed, []);
    identity.id = 'B';
    assert.equal(identity.id, 'B');
    assert.deepEqual(epochs(boundary), [2, 2]);
    assert.equal(invalidations, 2);
    assert.deepEqual(observed, ['B:synthetic']);
    current.csrf = 'next';
    assert.equal(current.csrf, 'next');
    assert.equal(boundary.session.value, current);
    assert.equal(current.identity, identity);
    assert.deepEqual(epochs(boundary), [3, 2]);
    assert.equal(invalidations, 3);
    assert.deepEqual(observed, ['B:synthetic', 'B:next']);
    stop();
  }
});
