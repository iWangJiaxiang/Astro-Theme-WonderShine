import { createDraftBackup } from "./draft-backup";

/** Coalesce DOM fallbacks; Vditor input already supplies serialized Markdown. */
export function createRichEditorSync(
  read: () => string | undefined,
  apply: (value: string) => void,
) {
  const pending = createDraftBackup(() => {
    const value = read();
    if (value !== undefined) apply(value);
  }, 100);
  return {
    schedule: pending.schedule,
    cancel: pending.cancel,
    flush: pending.flush,
    accept(value: string) {
      pending.cancel();
      apply(value);
    },
  };
}
