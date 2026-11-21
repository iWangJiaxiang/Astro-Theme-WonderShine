import { reauthentication } from "./api";
import { watch } from "./reactivity";

const focusLayers: HTMLDialogElement[] = [];

function tabStops(dialog: HTMLDialogElement): HTMLElement[] {
  const candidates = [...dialog.querySelectorAll<HTMLElement>(
    'a[href], area[href], button, input, select, textarea, summary, iframe, audio[controls], video[controls], [tabindex], [contenteditable="true"]',
  )].filter((node) => {
    // Closed details only exposes its first direct summary and its descendants.
    // Rects alone can include UA-hidden content, including nested disclosures.
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      if (!parent.matches("details:not([open])")) continue;
      const summary = [...parent.children].find((child) => child.tagName === "SUMMARY");
      if (!summary?.contains(node)) return false;
    }
    const style = getComputedStyle(node);
    return node.tabIndex >= 0 && !node.matches(':disabled, input[type="hidden"]') &&
      !node.closest('[inert], [hidden]') && node.getClientRects().length > 0 &&
      style.visibility !== "hidden" && style.visibility !== "collapse";
  });
  // Native radio groups have one sequential stop, not one per option. Keep the
  // browser in charge of arrow keys and ordinary movement within the dialog.
  return candidates.filter((node) => {
    if (!(node instanceof HTMLInputElement) || node.type !== "radio" || !node.name) return true;
    const group = candidates.filter((other): other is HTMLInputElement =>
      other instanceof HTMLInputElement && other.type === "radio" &&
      other.name === node.name && other.form === node.form);
    return node === (group.find((radio) => radio.checked) || group[0]);
  }).sort((a, b) => (a.tabIndex || Number.MAX_SAFE_INTEGER) - (b.tabIndex || Number.MAX_SAFE_INTEGER));
}

/** Native modality blocks the page, but can still Tab into browser chrome.
 * Keep an actual visible keyboard target in the most recently activated dialog.
 * Register all Studio native dialogs, including the blocking shared Modal.
 */
export function containModalFocus(dialog: HTMLDialogElement): () => void {
  focusLayers.push(dialog);
  const addedTabIndex = !dialog.hasAttribute("tabindex");
  if (addedTabIndex) dialog.tabIndex = -1;
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    const index = focusLayers.lastIndexOf(dialog);
    if (index !== -1) focusLayers.splice(index, 1);
    document.removeEventListener("keydown", onKeyDown, true);
    dialog.removeEventListener("close", onClose);
    observer.disconnect();
    if (addedTabIndex) dialog.removeAttribute("tabindex");
  }
  function onClose() {
    // A queued native close event may belong to an earlier open of this node.
    if (!dialog.open) dispose();
  }
  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
    if (!dialog.isConnected || !dialog.open) { dispose(); return; }
    const top = [...focusLayers].reverse().find((node) => node.isConnected && node.matches(":modal"));
    if (top !== dialog) return;
    const active = document.activeElement;
    // Do not override a native dialog opened outside this activation owner.
    const activeModal = active?.closest("dialog:modal");
    if (activeModal && activeModal !== dialog && !focusLayers.includes(activeModal as HTMLDialogElement)) return;
    const stops = tabStops(dialog);
    const first = stops[0], last = stops[stops.length - 1];
    const outside = !active || active === dialog || !dialog.contains(active);
    const target = !first ? dialog : event.shiftKey
      ? (outside || active === first ? last : undefined)
      : (outside || active === last ? first : undefined);
    if (!target) return;
    // Prevent before the UA's boundary navigation, not after body/chrome focus.
    event.preventDefault();
    target.focus();
  }
  const observer = new MutationObserver(() => {
    if (!dialog.isConnected || !dialog.open) {
      dispose();
      // Removing a dialog does not clear its open attribute. Never retain an
      // apparently open, disconnected owner or its document-level listeners.
      if (!dialog.isConnected && dialog.open) dialog.close();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });
  document.addEventListener("keydown", onKeyDown, true);
  dialog.addEventListener("close", onClose);
  return dispose;
}

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
  let releaseFocus: (() => void) | undefined;

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
        releaseFocus?.();
        node.showModal();
        releaseFocus = containModalFocus(node);
        onOpen?.(node);
      }
    }, 0);
  }
  const stop = watch(reauthentication, (required) => {
    if (!required) schedule();
  });
  function close() {
    cancelPending();
    releaseFocus?.();
    releaseFocus = undefined;
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
