import { reauthentication } from "./api";
import { watch } from "./reactivity";

/** Own native activation, not business work. Already-open dialogs stay mounted. */
export function createBusinessModal(
  getDialog: () => HTMLDialogElement | null | undefined,
  wantsOpen: () => boolean,
  onOpen?: (dialog: HTMLDialogElement) => void,
) {
  let disposed = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // DOM refs can be cleared before the owner's lifecycle cleanup.
  let openedDialog: HTMLDialogElement | undefined;

  function cancelPending() {
    pending = false;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }
  function schedule() {
    if (disposed || !pending || timer !== undefined) return;
    // Wait for React's commit and, on resume, the blocking modal's removal.
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed || !pending) return;
      const node = getDialog();
      if (!wantsOpen() || !node?.isConnected) {
        cancelPending();
        return;
      }
      // Check at activation time, not before the asynchronous commit boundary.
      if (reauthentication.value) return;
      pending = false;
      openedDialog = node;
      if (!node.open) {
        node.showModal();
        onOpen?.(node);
      }
    }, 0);
  }
  const stop = watch(reauthentication, (required) => {
    if (!required) schedule();
  });
  function close() {
    cancelPending();
    if (openedDialog?.open) openedDialog.close();
    openedDialog = undefined;
  }
  return {
    open() {
      if (disposed) return;
      pending = true;
      schedule();
    },
    close,
    dispose() {
      disposed = true;
      stop();
      close();
    },
  };
}
