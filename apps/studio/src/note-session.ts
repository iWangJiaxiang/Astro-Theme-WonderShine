import type { Json } from '../shared/types';

export interface NoteDraft { path: string; initial?: Record<string, Json>; initialBody?: string }
export interface EditorDraft { initial: Record<string, Json>; initialBody: string }

// Vditor represents an untouched empty document with a newline on mode changes.
export function richEditorBody(previous: string, value: string): string {
  return previous === '' && value === '\n' ? '' : value;
}

// An explicit initialBody marks a carried user draft, including reference-only drafts.
export function unsavedNoteChanged(initialBody: string | undefined, body: string, values: Record<string, Json>, pristine: string): boolean {
  return initialBody !== undefined || !!body || JSON.stringify(values) !== pristine;
}

export function retargetNoteDraft(path: string, snapshot: EditorDraft, dirty: boolean): NoteDraft {
  return { path, initial: snapshot.initial, ...(dirty ? { initialBody: snapshot.initialBody } : {}) };
}

export function retainNoteDraft(drafts: NoteDraft[], draft: NoteDraft): NoteDraft[] {
  return [...drafts.filter(item => item.path !== draft.path), draft];
}
