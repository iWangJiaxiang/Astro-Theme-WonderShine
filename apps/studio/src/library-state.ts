export type LibraryKind = "article" | "page" | "collection";
export type LibraryListState = {
  search: string;
  status: string;
  folder: string;
  page: number;
};

/** Edits made while the first read is pending win field-by-field, including clears. */
export function initialLibraryState(
  saved: LibraryListState | undefined,
  fallback: LibraryListState,
  edits: Partial<LibraryListState> = {},
): LibraryListState {
  const merged = { ...(saved || fallback), ...edits };
  if (("search" in edits || "status" in edits || "folder" in edits) && !("page" in edits)) merged.page = 1;
  return merged;
}

/** One active account/workspace only. Leases cannot revive entries after a reset. */
export function libraryStateMemory() {
  let context: string | null = null;
  let generation = 0;
  const lists = new Map<string, LibraryListState>();
  const selected = new Map<LibraryKind, string>();
  return {
    activate(next: string | null) {
      if (context === next) return false;
      context = next;
      generation++;
      lists.clear();
      selected.clear();
      return true;
    },
    capture(kind: LibraryKind) {
      const captured = generation;
      const current = () => context !== null && captured === generation;
      const key = (language: string) => JSON.stringify([kind, language]);
      return {
        current,
        language: () => current() ? selected.get(kind) : undefined,
        read(language: string) {
          const state = current() ? lists.get(key(language)) : undefined;
          return state ? { ...state } : undefined;
        },
        write(language: string, state: LibraryListState) {
          if (!current() || !language) return;
          selected.set(kind, language);
          lists.set(key(language), { ...state });
        },
      };
    },
  };
}
