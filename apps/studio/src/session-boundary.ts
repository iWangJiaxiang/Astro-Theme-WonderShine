import { batch, signal } from '@preact/signals-react';
import type { Identity } from '../shared/types';
import type { Ref } from './reactivity';

export interface SessionState { identity: Identity; csrf: string; expires: number }
export interface SessionBoundary {
  readonly session: Ref<SessionState | null>;
  readonly authenticationEpoch: number;
  readonly identityEpoch: number;
}
export interface SessionBoundaryOptions {
  /** Synchronous API invalidation only: committed state is already authoritative. */
  invalidate?: () => void;
}

const invalidState = (): never => { throw new TypeError('Invalid session state'); };
const sessionKeys = ['identity', 'csrf', 'expires'] as const;
const identityKeys = ['id', 'name', 'method'] as const;

/** Copy data descriptors, never invoke ordinary input accessors. Not a JS sandbox. */
function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object') return invalidState();
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return invalidState();
  const ownKeys = Reflect.ownKeys(input);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return invalidState();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return invalidState();
    result[key] = descriptor.value;
  }
  return result;
}
function text(input: unknown): string {
  return typeof input === 'string' ? input : invalidState();
}
function method(input: unknown): Identity['method'] {
  return input === 'password' || input === 'oidc' ? input : invalidState();
}
function expiration(input: unknown): number {
  return typeof input === 'number' && Number.isFinite(input) ? input : invalidState();
}

/**
 * API-owned, two-level mutable session records. Writes through raw input aliases
 * never mutate this state. Detached proxies are snapshots, not reusable owners.
 * Object.assign is a sequence of individual writes, not an atomic transaction.
 */
export function createSessionBoundary({ invalidate }: SessionBoundaryOptions = {}): SessionBoundary {
  interface IdentityNode { data: Identity; proxy: Identity }
  interface SessionNode { data: SessionState; identity: IdentityNode; proxy: SessionState }
  const identities = new WeakMap<object, IdentityNode>();
  const sessions = new WeakMap<object, SessionNode>();
  // The only signal is a publication revision. Authority is ordinary synchronous state.
  const revision = signal(0);
  let active: SessionNode | null = null;
  let authenticationEpoch = 0, identityEpoch = 0;

  function readIdentity(input: unknown): Identity {
    try {
      const owned = input && typeof input === 'object' ? identities.get(input) : undefined;
      const data = owned?.data ?? record(input, identityKeys);
      return { id: text(data.id), name: text(data.name), method: method(data.method) };
    } catch { return invalidState(); }
  }
  function readSession(input: unknown): SessionState {
    try {
      const owned = input && typeof input === 'object' ? sessions.get(input) : undefined;
      const data = owned?.data ?? record(input, sessionKeys);
      return { identity: readIdentity(data.identity), csrf: text(data.csrf), expires: expiration(data.expires) };
    } catch { return invalidState(); }
  }

  function commit(write: () => void, authentication: boolean, identity: boolean) {
    // Refuse exhaustion before changing state; never wrap an authority counter.
    if ((authentication && authenticationEpoch === Number.MAX_SAFE_INTEGER) ||
        (identity && identityEpoch === Number.MAX_SAFE_INTEGER)) return invalidState();
    batch(() => {
      write();
      if (authentication) authenticationEpoch++;
      if (identity) identityEpoch++;
      try {
        // May synchronously reenter. No outer state/epoch writes follow this hook.
        if (authentication) invalidate?.();
      } finally {
        // Publish the latest state, including nested commits, even if the hook throws.
        // Never assign a captured old generation after reentry.
        revision.value = revision.peek() + 1;
      }
    });
  }

  function makeIdentity(data: Identity): IdentityNode {
    const node = { data } as IdentityNode;
    const track = () => { if (active?.identity === node) void revision.value; };
    node.proxy = new Proxy(data, {
      get(target, key) { track(); return Reflect.get(target, key); },
      has(target, key) { track(); return Reflect.has(target, key); },
      ownKeys(target) { track(); return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor(target, key) { track(); return Reflect.getOwnPropertyDescriptor(target, key); },
      set(target, key, input: unknown) {
        if (key !== 'id' && key !== 'name' && key !== 'method') return invalidState();
        const next = key === 'method' ? method(input) : text(input);
        if (Object.is(target[key], next)) return true;
        const write = () => {
          // Explicit target writes avoid receiver-driven defineProperty reentry.
          if (key === 'method') target.method = next as Identity['method'];
          else target[key] = next;
        };
        if (active?.identity === node) commit(write, key !== 'name', key !== 'name');
        else write();
        return true;
      },
      defineProperty: invalidState,
      deleteProperty: invalidState,
      setPrototypeOf: invalidState,
      preventExtensions: invalidState,
    });
    identities.set(node.proxy, node);
    return node;
  }
  function makeSession(data: SessionState): SessionNode {
    const identity = makeIdentity(data.identity);
    const node = { data: { identity: identity.proxy, csrf: data.csrf, expires: data.expires }, identity } as SessionNode;
    const track = () => { if (active === node) void revision.value; };
    node.proxy = new Proxy(node.data, {
      get(target, key) { track(); return Reflect.get(target, key); },
      has(target, key) { track(); return Reflect.has(target, key); },
      ownKeys(target) { track(); return Reflect.ownKeys(target); },
      // data.identity is always the owned proxy, including descriptor/spread reads.
      getOwnPropertyDescriptor(target, key) { track(); return Reflect.getOwnPropertyDescriptor(target, key); },
      set(target, key, input: unknown) {
        if (key === 'identity') {
          if (input === node.identity.proxy) return true;
          const next = makeIdentity(readIdentity(input));
          const changed = node.identity.data.id !== next.data.id || node.identity.data.method !== next.data.method;
          const write = () => { node.identity = next; target.identity = next.proxy; };
          if (active === node) commit(write, true, changed);
          else write();
        } else if (key === 'csrf') {
          const next = text(input);
          if (Object.is(target.csrf, next)) return true;
          const write = () => { target.csrf = next; };
          if (active === node) commit(write, true, false);
          else write();
        } else if (key === 'expires') {
          const next = expiration(input);
          if (Object.is(target.expires, next)) return true;
          const write = () => { target.expires = next; };
          if (active === node) commit(write, true, false);
          else write();
        } else return invalidState();
        return true;
      },
      defineProperty: invalidState,
      deleteProperty: invalidState,
      setPrototypeOf: invalidState,
      preventExtensions: invalidState,
    });
    sessions.set(node.proxy, node);
    return node;
  }

  const session = Object.preventExtensions(Object.defineProperty({}, 'value', {
    enumerable: true,
    configurable: false,
    get(): SessionState | null { void revision.value; return active?.proxy ?? null; },
    set(input: SessionState | null) {
      if (input === (active?.proxy ?? null)) return;
      // Normalize entirely before the commit. Reattaching an old proxy copies it.
      const next = input === null ? null : makeSession(readSession(input));
      const changed = !!active !== !!next || active?.identity.data.id !== next?.identity.data.id ||
        active?.identity.data.method !== next?.identity.data.method;
      commit(() => { active = next; }, true, changed);
    },
  })) as Ref<SessionState | null>;

  return Object.freeze({
    session,
    get authenticationEpoch() { void revision.value; return authenticationEpoch; },
    get identityEpoch() { void revision.value; return identityEpoch; },
  });
}
