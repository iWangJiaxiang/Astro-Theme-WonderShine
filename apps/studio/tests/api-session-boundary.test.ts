import assert from 'node:assert/strict';
import { test } from 'node:test';
import { batch } from '@preact/signals-react';
import { computed, watch, type Ref } from '../src/reactivity';
import type { SessionState } from '../src/session-boundary';

Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { lang: '' }, title: '' } });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {} } });
const {
  api, ApiError, session, authenticationEpoch, identityEpoch, apiTransportGeneration,
  setApiTransport, pendingMutations, reauthentication,
} = await import('../src/api');
const { locale } = await import('../src/i18n');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const identity = (id = 'A'): SessionState => ({ identity: { id, name: 'Synthetic', method: 'password' }, csrf: 'synthetic', expires: Number.MAX_SAFE_INTEGER });
const reset = () => { setApiTransport(); session.value = null; reauthentication.value = false; locale.value = 'zh-CN'; };
function hold(stage: 'transport' | 'json', status = 401, data: unknown = { error: 'synthetic unauthorized' }) {
  const responseGate = deferred<void>(), jsonGate = deferred<void>();
  const transportEntered = deferred<void>(), transportDrained = deferred<void>();
  const jsonEntered = deferred<void>(), jsonDrained = deferred<void>();
  const response = new Response(null, { status });
  response.json = async () => {
    jsonEntered.resolve();
    try { await jsonGate.promise; return data; }
    finally { jsonDrained.resolve(); }
  };
  const transport = async () => {
    transportEntered.resolve();
    try { if (stage === 'transport') await responseGate.promise; return response; }
    finally { transportDrained.resolve(); }
  };
  return {
    transport, transportEntered: transportEntered.promise, transportDrained: transportDrained.promise,
    entered: stage === 'transport' ? transportEntered.promise : jsonEntered.promise,
    jsonDrained: jsonDrained.promise,
    release() { responseGate.resolve(); jsonGate.resolve(); },
  };
}

// One serial parent owns the actual API singleton; every held operation is released in finally.
test('API session boundary integration', { concurrency: false, timeout: 15000 }, async t => {
  t.after(reset);
  await t.test('owned stable Ref and readonly reactive authority record every batched write', () => {
    reset();
    const compatible: Ref<SessionState | null> = session;
    const input = identity();
    compatible.value = input;
    const previous = session.value!;
    const auth = authenticationEpoch.value, owner = identityEpoch.value;
    const observed: number[] = [];
    const stop = watch(authenticationEpoch, value => observed.push(value));
    const derived = computed(() => identityEpoch.value);
    try {
      assert.equal(session.value, previous);
      session.value = previous;
      session.value!.identity = previous.identity;
      previous.identity.name = 'Renamed';
      assert.equal(authenticationEpoch.value, auth);
      input.identity.id = 'outside';
      assert.equal(previous.identity.id, 'A');
      batch(() => {
        session.value = identity('B');
        assert.equal(authenticationEpoch.value, auth + 1);
        assert.equal(identityEpoch.value, owner + 1);
        session.value = previous;
        assert.notEqual(session.value, previous);
        assert.equal(authenticationEpoch.value, auth + 2);
        assert.equal(identityEpoch.value, owner + 2);
        const current = session.value!;
        current.csrf = 'next'; current.csrf = 'synthetic';
        current.expires = 1; current.expires = Number.MAX_SAFE_INTEGER;
        current.identity.method = 'oidc'; current.identity.method = 'password';
        current.identity.id = 'B'; current.identity.id = 'A';
        assert.equal(authenticationEpoch.value, auth + 10);
        assert.equal(identityEpoch.value, owner + 6);
        session.value = null;
        assert.equal(identityEpoch.value, owner + 7);
        session.value = previous;
        assert.equal(authenticationEpoch.value, auth + 12);
        assert.equal(identityEpoch.value, owner + 8);
      });
      assert.deepEqual(observed, [auth + 12]);
      assert.equal(derived.value, owner + 8);
      for (const counter of [authenticationEpoch, identityEpoch, apiTransportGeneration]) {
        assert.equal(Object.isFrozen(counter), true);
        assert.equal(Object.getOwnPropertyDescriptor(counter, 'value')!.set, undefined);
        assert.equal(Reflect.set(counter, 'value', -1), false);
        assert.equal(Reflect.defineProperty(counter, 'value', { value: -1 }), false);
      }
      const before = authenticationEpoch.value;
      session.value = identity();
      assert.equal(authenticationEpoch.value, before + 1, 'distinct raw same-content record is an auth boundary');
      assert.equal(identityEpoch.value, owner + 8);
      previous.csrf = 'detached';
      assert.equal(authenticationEpoch.value, before + 1);
    } finally { stop(); }
  });

  for (const stage of ['transport', 'json'] as const) {
    for (const change of ['object-roundtrip', 'null-roundtrip', 'id', 'method', 'csrf', 'expires', 'transport-reused'] as const) {
      await t.test(`old content 401: ${stage}/${change}`, async () => {
        reset(); session.value = identity();
        const held = hold(stage);
        let calls = 0;
        const transport = () => ++calls === 1 ? held.transport() : Promise.resolve(Response.json(['current']));
        setApiTransport(transport);
        const pending = api('/content');
        const rejected = assert.rejects(pending, { status: 409 });
        try {
          await held.entered;
          const original = session.value!;
          batch(() => {
            if (change === 'object-roundtrip') { session.value = identity('B'); session.value = original; }
            if (change === 'null-roundtrip') { session.value = null; session.value = original; }
            if (change === 'id') { original.identity.id = 'B'; original.identity.id = 'A'; }
            if (change === 'method') { original.identity.method = 'oidc'; original.identity.method = 'password'; }
            if (change === 'csrf') { original.csrf = 'next'; original.csrf = 'synthetic'; }
            if (change === 'expires') { original.expires = 1; original.expires = Number.MAX_SAFE_INTEGER; }
            if (change === 'transport-reused') setApiTransport(transport);
          });
          await rejected; // Must wake before the held transport/JSON is released.
          assert.deepEqual(await api('/content'), ['current']);
          assert.equal(calls, 2);
        } finally {
          held.release();
          await Promise.allSettled([pending, rejected]);
          await held.transportDrained;
          if (stage === 'json') await held.jsonDrained;
        }
        assert.equal(reauthentication.value, false);
      });
    }
  }

  for (const stage of ['transport', 'json'] as const) {
    for (const change of ['auth-roundtrip', 'csrf', 'expires', 'same-object-content', 'transport-reused', 'locale', 'name', 'none'] as const) {
      await t.test(`PUT 401 permission and true pending: ${stage}/${change}`, async () => {
        reset(); session.value = identity();
        const held = hold(stage);
        let calls = 0;
        const transport = () => { calls++; return held.transport(); };
        setApiTransport(transport);
        const pending = api('/settings/site', 'PUT', {});
        const rejected = assert.rejects(pending, { status: change === 'transport-reused' ? 409 : 401 });
        try {
          await held.entered;
          batch(() => {
            if (change === 'auth-roundtrip') { const original = session.value; session.value = identity('B'); session.value = original; }
            if (change === 'csrf') session.value!.csrf = 'next';
            if (change === 'expires') session.value!.expires = 1;
            if (change === 'same-object-content') session.value = identity();
            if (change === 'transport-reused') setApiTransport(transport);
            if (change === 'locale') locale.value = 'en';
            if (change === 'name') session.value!.identity.name = 'Renamed';
          });
          assert.equal(pendingMutations.value, 1);
          assert.equal(calls, 1);
          await assert.rejects(api('/auth/logout', 'POST'), { status: 409 });
          assert.equal(pendingMutations.value, 1);
        } finally {
          held.release();
          await Promise.allSettled([pending, rejected]);
        }
        await rejected;
        assert.equal(reauthentication.value, ['locale', 'name', 'none'].includes(change));
        assert.equal(pendingMutations.value, 0);
        assert.equal(calls, 1, 'no automatic mutation replay');
      });
    }
  }

  for (const status of [200, 409]) {
    for (const stage of ['transport', 'json'] as const) {
      for (const change of ['locale', 'auth'] as const) {
        await t.test(`PUT retains return contract: ${status}/${stage}/${change}`, async () => {
          reset(); session.value = identity();
          const data = { revision: 'synthetic-revision', error: 'synthetic conflict' };
          const held = hold(stage, status, data);
          let calls = 0;
          setApiTransport(() => { calls++; return held.transport(); });
          const pending = api('/settings/site', 'PUT', {});
          const outcome = status === 409 ? assert.rejects(pending, { status: 409 }) : pending;
          try {
            await held.entered;
            if (change === 'locale') { locale.value = 'en'; locale.value = 'zh-CN'; }
            else session.value = identity('B');
            assert.equal(pendingMutations.value, 1);
          } finally { held.release(); await Promise.allSettled([pending, outcome]); }
          if (status === 200) assert.equal(await outcome, data);
          else await outcome;
          assert.equal(calls, 1);
          assert.equal(pendingMutations.value, 0);
        });
      }
    }
  }

  await t.test('non-content GET checks both held boundaries; login/no-session 401 cannot request reauth', async () => {
    for (const stage of ['transport', 'json'] as const) {
      reset(); session.value = identity();
      const held = hold(stage);
      setApiTransport(held.transport);
      const pending = api('/settings/site');
      const rejected = assert.rejects(pending, { status: 409 });
      try { await held.entered; session.value = identity(); }
      finally { held.release(); await Promise.allSettled([pending, rejected]); }
      await rejected;
      assert.equal(reauthentication.value, false);
    }
    for (const path of ['/auth/login', '/settings/site']) {
      reset();
      if (path === '/auth/login') session.value = identity();
      setApiTransport(async () => Response.json({ error: 'synthetic unauthorized' }, { status: 401 }));
      await assert.rejects(api(path, 'PUT', {}), { status: 401 });
      assert.equal(reauthentication.value, false);
    }
  });

  await t.test('same-function/default reset notifies latest authority; mutation rejection identity remains exact', async () => {
    reset();
    const transport = async () => Response.json({});
    const before = apiTransportGeneration.value;
    const observed: number[] = [];
    const stop = watch(apiTransportGeneration, value => observed.push(value));
    try {
      batch(() => {
        setApiTransport(transport); assert.equal(apiTransportGeneration.value, before + 1);
        setApiTransport(transport); assert.equal(apiTransportGeneration.value, before + 2);
        setApiTransport(); setApiTransport(); assert.equal(apiTransportGeneration.value, before + 4);
      });
      assert.deepEqual(observed, [before + 4]);
    } finally { stop(); }
    const failure = new Error('synthetic transport rejection');
    setApiTransport(async () => { throw failure; });
    await assert.rejects(api('/settings/site', 'PUT', {}), error => error === failure);
    assert.equal(pendingMutations.value, 0);
    reauthentication.value = true;
    session.value = identity();
    const held = hold('json');
    setApiTransport(held.transport);
    const pending = api('/settings/site', 'PUT', {});
    const rejected = assert.rejects(pending, { status: 401 });
    try { await held.entered; session.value = identity('B'); }
    finally { held.release(); await Promise.allSettled([pending, rejected]); }
    await rejected;
    assert.equal(reauthentication.value, true, 'stale errors do not clear an existing reauth requirement');
  });

  await t.test('actual content abort reentry commits nested transport/session and direct request before publication', async () => {
    reset(); session.value = identity();
    const held = hold('transport', 200, []);
    const entered = deferred<void>();
    let listenerCalls = 0, nested: Promise<unknown> | undefined;
    const finalTransport = async () => Response.json(['latest']);
    const initialTransport = async (_path: string, init: RequestInit) => {
      init.signal!.addEventListener('abort', () => {
        listenerCalls++;
        assert.equal(session.value!.identity.id, 'B');
        const generation = apiTransportGeneration.value;
        setApiTransport(finalTransport);
        assert.equal(apiTransportGeneration.value, generation + 1);
        session.value = identity('C');
        nested = api('/settings/site');
      }, { once: true });
      entered.resolve();
      return held.transport();
    };
    setApiTransport(initialTransport);
    const pending = api('/content');
    const rejected = assert.rejects(pending, { status: 409 });
    try {
      await entered.promise;
      session.value = identity('B');
      assert.equal(listenerCalls, 1);
      assert.equal(session.value!.identity.id, 'C');
      assert.deepEqual(await nested, ['latest']);
      await rejected;
      assert.deepEqual(await api('/content'), ['latest']);
    } finally { held.release(); await Promise.allSettled([pending, rejected, nested]); await held.transportDrained; }
  });

  await t.test('transport invalidation abort reentry sees the committed generation and nested setter wins', async () => {
    reset(); session.value = identity();
    const entered = deferred<void>();
    const held = hold('transport', 200, []);
    const finalTransport = async () => Response.json(['nested']);
    let nested: Promise<unknown> | undefined, calls = 0;
    const outerGeneration = apiTransportGeneration.value + 2;
    setApiTransport(async (_path, init) => {
      init.signal!.addEventListener('abort', () => {
        calls++;
        assert.equal(apiTransportGeneration.value, outerGeneration);
        setApiTransport(finalTransport);
        nested = api('/settings/site');
      }, { once: true });
      entered.resolve();
      return held.transport();
    });
    const pending = api('/content');
    const rejected = assert.rejects(pending, { status: 409 });
    try {
      await entered.promise;
      setApiTransport(async () => Response.json(['outer']));
      assert.equal(apiTransportGeneration.value, outerGeneration + 1);
      assert.equal(calls, 1);
      assert.deepEqual(await nested, ['nested']);
      await rejected;
      assert.deepEqual(await api('/content'), ['nested']);
    } finally { held.release(); await Promise.allSettled([pending, rejected, nested]); await held.transportDrained; }
  });

  await t.test('transport notification reentry/failure never restores outer transport or generation', async () => {
    reset();
    const failure = new Error('synthetic notification failure');
    const before = apiTransportGeneration.value;
    let armed = true, nested: Promise<unknown> | undefined;
    const finalTransport = async () => Response.json(['final']);
    const stop = watch(apiTransportGeneration, () => {
      if (!armed) return;
      armed = false;
      setApiTransport(finalTransport);
      nested = api('/settings/site');
      throw failure;
    });
    try {
      assert.throws(() => setApiTransport(async () => Response.json(['outer'])), error => error === failure);
      assert.equal(apiTransportGeneration.value, before + 2);
      assert.deepEqual(await nested, ['final']);
      assert.deepEqual(await api('/settings/site'), ['final']);
    } finally { stop(); await Promise.allSettled([nested]); }
  });

  await t.test('stable previousSession/logout comparison and switch exception survive held JSON', async () => {
    reset(); session.value = identity();
    const held = hold('json', 200, {});
    setApiTransport(held.transport);
    const previous = session.value;
    const logout = api('/auth/logout', 'POST');
    try {
      await held.entered;
      assert.equal(session.value, previous);
      assert.equal(pendingMutations.value, 1);
      await assert.rejects(api('/settings/site', 'PUT', {}), { status: 409 });
      session.value = identity();
      assert.notEqual(session.value, previous);
      setApiTransport(async () => Response.json({}));
    } finally { held.release(); await Promise.allSettled([logout]); }
    await logout;
    // The unchanged App conditional must not clear this newer same-id object.
    if (session.value === previous) session.value = null;
    assert.notEqual(session.value, null);
    assert.equal(pendingMutations.value, 0);
    assert.ok(ApiError.prototype instanceof Error);
  });
});
