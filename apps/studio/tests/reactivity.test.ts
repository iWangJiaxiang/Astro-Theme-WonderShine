import test from 'node:test';
import assert from 'node:assert/strict';
import { batch, computed, ref, shallowRef, watch, withLifecycle, type Lifecycle } from '../src/reactivity';

test('nested editor mutations invalidate dirty state and backup observers', () => {
  const metadata = ref({ title: 'First', tags: ['one'], extra: { draft: true } });
  const baseline = JSON.stringify(metadata.value);
  const dirty = computed(() => JSON.stringify(metadata.value) !== baseline);
  const snapshots: string[] = [];
  const stop = watch(metadata, value => snapshots.push(JSON.stringify(value)), { deep: true });
  assert.equal(dirty.value, false);
  metadata.value.extra.draft = false;
  metadata.value.tags.push('two');
  assert.equal(dirty.value, true);
  assert.deepEqual(JSON.parse(snapshots.at(-1)!), { title: 'First', tags: ['one', 'two'], extra: { draft: false } });
  metadata.value = JSON.parse(baseline);
  assert.equal(dirty.value, false);
  stop();
});

test('watch callbacks do not accidentally subscribe to state they read', () => {
  const session = ref<string | null>(null), error = ref('');
  let calls = 0;
  const stop = watch(session, () => { calls++; if (error.value) error.value = ''; });
  error.value = 'Expired';
  assert.equal(calls, 0);
  session.value = 'owner';
  assert.equal(calls, 1);
  assert.equal(error.value, '');
  stop();
});

test('component cleanup detaches watchers and batch publishes final state', () => {
  const lifecycle: Lifecycle = { mounted: [], cleanup: [], context: new Map() };
  const title = ref('one'), body = ref('draft');
  const updates: string[] = [];
  withLifecycle(lifecycle, () => watch([title, body], values => updates.push(values.join(':'))));
  batch(() => { title.value = 'two'; body.value = 'saved'; });
  assert.deepEqual(updates, ['two:saved']);
  for (const cleanup of lifecycle.cleanup) cleanup();
  title.value = 'three';
  assert.deepEqual(updates, ['two:saved']);
});

test('shallow data and native handles retain their original identity', () => {
  const native = new Map([['token', 'opaque']]);
  assert.equal(ref(native).value, native);
  const source = { title: 'a' }, state = shallowRef(source);
  assert.equal(state.value, source);
  let calls = 0;
  const stop = watch(state, () => calls++);
  state.value.title = 'b';
  assert.equal(calls, 0);
  state.value = { title: 'c' };
  assert.equal(calls, 1);
  stop();
});
