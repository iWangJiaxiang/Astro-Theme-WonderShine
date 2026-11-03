import { ref } from '../src/reactivity';

export interface RecoveryIdentity { id: string; method: string }
export interface LegacyRecovery { legacy: RecoveryIdentity; current: RecoveryIdentity }
// Set only by a successful authentication response from the active native transport.
export const legacyRecovery = ref<LegacyRecovery | null>(null);
type RecoveryStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem'>;

export function recoveryKeys(storage: RecoveryStorage, context: LegacyRecovery, authenticated: RecoveryIdentity | undefined) {
  if (!authenticated || authenticated.id !== context.current.id || authenticated.method !== context.current.method || context.legacy.method !== authenticated.method) throw new Error('请先登录原账号再恢复旧草稿。');
  const old = `${context.legacy.method}:${context.legacy.id}`;
  const next = `${context.current.method}:${context.current.id}`;
  const prefixes = ['studio-draft:', 'studio-settings:'].map(prefix => [prefix + old + ':', prefix + next + ':']);
  // Save preferences historically omit the authentication method.
  prefixes.push(['studio.save-default.v1:' + context.legacy.id + ':', 'studio.save-default.v1:' + context.current.id + ':']);
  const exact = new Map([
    [`studio-thread-session:${old}`, `studio-thread-session:${next}`],
    [`studio-thread-session:${old}:unsaved`, `studio-thread-session:${next}:unsaved`],
    [`studio-guide:v1:${old}`, `studio-guide:v1:${next}`],
  ]);
  const keys: [string, string][] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key) continue;
    let target = exact.get(key);
    const prefix = prefixes.find(([source]) => key.startsWith(source));
    if (prefix) target = prefix[1] + key.slice(prefix[0].length);
    if (target) keys.push([key, target]);
  }
  return keys;
}

/** Explicit copy only. Existing targets win even without comparable timestamps. */
export function importLegacyRecovery(storage: RecoveryStorage, context: LegacyRecovery, authenticated: RecoveryIdentity | undefined) {
  let copied = 0;
  for (const [source, target] of recoveryKeys(storage, context, authenticated)) {
    const value = storage.getItem(source);
    if (value !== null && storage.getItem(target) === null) { storage.setItem(target, value); copied++; }
  }
  return copied;
}
