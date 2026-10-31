import type { Identity } from '../shared/types';

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type DraftIdentity = Pick<Identity, 'method' | 'id'>;

function matchesPath(value: unknown, path: string): boolean {
  return typeof value === 'object' && value !== null && 'path' in value && value.path === path;
}

// Run only after a successful repository deletion. Each operation is independent:
// unavailable browser storage must not turn an already-completed deletion into an error.
export function forgetDeletedContent(storage: DraftStorage, identity: DraftIdentity, path: string): void {
  const owner = `${identity.method}:${identity.id}`;
  const sessionKey = `studio-note-session:${owner}`;
  try { storage.removeItem(`studio-draft:${owner}:${path}`); } catch { /* Storage can be unavailable. */ }
  try {
    const active: unknown = JSON.parse(storage.getItem(sessionKey) || 'null');
    if (matchesPath(active, path)) storage.removeItem(sessionKey);
  } catch { /* Preserve malformed or inaccessible session data. */ }
  try {
    const key = `${sessionKey}:unsaved`;
    const drafts: unknown = JSON.parse(storage.getItem(key) || 'null');
    if (!Array.isArray(drafts)) return;
    const remaining = drafts.filter(draft => !matchesPath(draft, path));
    if (remaining.length !== drafts.length) storage.setItem(key, JSON.stringify(remaining));
  } catch { /* Preserve malformed or inaccessible pending drafts. */ }
}
