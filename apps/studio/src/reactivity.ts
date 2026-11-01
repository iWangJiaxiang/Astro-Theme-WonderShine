import {
  signal,
  computed as derive,
  effect,
  untracked,
  batch,
  type ReadonlySignal,
} from "@preact/signals-react";
export { useSignals } from "@preact/signals-react/runtime";
export { batch };

/** Framework-neutral mutable cells; only plain records/arrays need deep tracking. */
export interface Ref<T> {
  value: T;
}
const rawValues = new WeakMap<object, object>();
function observable<T>(
  value: T,
  changed: () => void,
  read: () => void,
  cache = new WeakMap<object, object>(),
): T {
  if (
    !value ||
    typeof value !== "object" ||
    (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
  )
    return value;
  const raw = rawValues.get(value) || value;
  const existing = cache.get(raw);
  if (existing) return existing as T;
  const proxy = new Proxy(raw, {
    get(target, key, receiver) {
      read();
      return observable(
        Reflect.get(target, key, receiver),
        changed,
        read,
        cache,
      );
    },
    set(target, key, next, receiver) {
      const old = Reflect.get(target, key, receiver);
      const ok = Reflect.set(target, key, next, receiver);
      if (ok && !Object.is(old, next)) changed();
      return ok;
    },
    deleteProperty(target, key) {
      const had = Reflect.has(target, key);
      const ok = Reflect.deleteProperty(target, key);
      if (ok && had) changed();
      return ok;
    },
    ownKeys(target) {
      read();
      return Reflect.ownKeys(target);
    },
  });
  rawValues.set(proxy, raw);
  cache.set(raw, proxy);
  return proxy as T;
}
export function ref<T>(): Ref<T | undefined>;
export function ref<T>(value: T): Ref<T>;
export function ref<T>(initial?: T): Ref<T | undefined> {
  const revision = signal(0);
  const changed = () => {
    revision.value = revision.peek() + 1;
  };
  let value = observable(initial, changed, () => {
    void revision.value;
  });
  return {
    get value() {
      void revision.value;
      return value;
    },
    set value(next) {
      if (Object.is(value, next)) return;
      value = observable(next, changed, () => {
        void revision.value;
      });
      changed();
    },
  };
}
export function shallowRef<T>(value: T): Ref<T> {
  return signal(value);
}
export function computed<T>(getter: () => T): ReadonlySignal<T> {
  return derive(getter);
}
export type WatchSource<T> = Ref<T> | (() => T);
type SourceValues<T extends readonly unknown[]> = {
  [K in keyof T]: T[K] extends WatchSource<infer V> ? V : never;
};
interface WatchOptions {
  immediate?: boolean;
  deep?: boolean;
  flush?: "sync" | "pre" | "post";
}
export function watch<T extends readonly unknown[]>(
  sources: readonly [...T],
  callback: (value: SourceValues<T>, old: SourceValues<T>) => unknown,
  options?: WatchOptions,
): () => void;
export function watch<T>(
  source: WatchSource<T>,
  callback: (value: T, old: T) => unknown,
  options?: WatchOptions,
): () => void;
export function watch(
  source: unknown,
  callback: (value: never, old: never) => unknown,
  options: WatchOptions = {},
): () => void {
  const read = (item: unknown): unknown =>
    typeof item === "function" ? item() : (item as Ref<unknown>).value;
  let first = true,
    previous: unknown;
  const stop = effect(() => {
    const value = Array.isArray(source) ? source.map(read) : read(source);
    if (options.deep) JSON.stringify(value);
    const changed =
      first ||
      options.deep ||
      (Array.isArray(source)
        ? (value as unknown[]).some(
            (v, i) => !Object.is(v, (previous as unknown[])[i]),
          )
        : !Object.is(value, previous));
    const old = previous;
    previous = value;
    const invoke = changed && (!first || options.immediate);
    first = false;
    if (invoke) untracked(() => callback(value as never, old as never));
  });
  lifecycle?.cleanup.push(stop);
  return stop;
}
export interface Lifecycle {
  mounted: (() => unknown)[];
  cleanup: (() => unknown)[];
  context: Map<symbol, unknown>;
}
let lifecycle: Lifecycle | undefined;
export function withLifecycle<T>(scope: Lifecycle, setup: () => T): T {
  const old = lifecycle;
  lifecycle = scope;
  try {
    return setup();
  } finally {
    lifecycle = old;
  }
}
export function onMounted(callback: () => unknown) {
  if (!lifecycle) throw new Error("Missing component lifecycle");
  lifecycle.mounted.push(callback);
}
export function onBeforeUnmount(callback: () => unknown) {
  if (!lifecycle) throw new Error("Missing component lifecycle");
  lifecycle.cleanup.push(callback);
}
export type InjectionKey<T> = symbol & { readonly __value?: T };
export function provide<T>(key: InjectionKey<T>, value: T) {
  if (!lifecycle) throw new Error("Missing component context");
  lifecycle.context.set(key, value);
}
export function inject<T>(key: InjectionKey<T>, fallback?: T): T | undefined {
  return (lifecycle?.context.get(key) as T | undefined) ?? fallback;
}
let nextId = 0;
export function useId() {
  return `studio-${++nextId}`;
}
/** Wait until React has committed DOM changes before using dialog/editor refs. */
export const nextTick = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));
