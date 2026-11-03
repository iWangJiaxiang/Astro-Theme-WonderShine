import type { Json } from '../shared/types';

export interface ThreadDraft { path: string; initial?: Record<string, Json>; initialBody?: string }
export interface EditorDraft { initial: Record<string, Json>; initialBody: string }

// Vditor represents an untouched empty document with a newline on mode changes.
export function richEditorBody(previous: string, value: string): string {
  return previous === '' && value === '\n' ? '' : value;
}

// An explicit initialBody marks a carried user draft, including reference-only drafts.
export function unsavedThreadChanged(initialBody: string | undefined, body: string, values: Record<string, Json>, pristine: string): boolean {
  return initialBody !== undefined || !!body || JSON.stringify(values) !== pristine;
}

export function retargetThreadDraft(path: string, snapshot: EditorDraft, dirty: boolean): ThreadDraft {
  return { path, initial: snapshot.initial, ...(dirty ? { initialBody: snapshot.initialBody } : {}) };
}

export function retainThreadDraft(drafts: ThreadDraft[], draft: ThreadDraft): ThreadDraft[] {
  return [...drafts.filter(item => item.path !== draft.path), draft];
}
