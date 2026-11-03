/** Coalesce input backups without starving them during continuous typing. */
export function createDraftBackup(write: () => void, delay = 300) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  function cancel() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }
  function flush() {
    cancel();
    write();
  }
  return {
    schedule() {
      if (timer === undefined) timer = setTimeout(flush, delay);
    },
    flush,
    cancel,
  };
}
