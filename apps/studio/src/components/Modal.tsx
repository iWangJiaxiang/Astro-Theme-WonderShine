import type { ReactNode } from "react";
import { containModalFocus, createBusinessModal } from "../modal-layer";
import {
  classes,
  component,
  domEvent,
  domRef,
  element,
  portal,
  type StudioComponent,
} from "../react-component";
import { onBeforeUnmount, onMounted, ref } from "../reactivity";
import "./modal.css";

type Props = {
  children?: ReactNode;
  className?: string;
  label?: string;
  labelledBy?: string;
  describedBy?: string;
  initialFocus?: string;
  returnFocus?: HTMLElement | null;
  blocking?: boolean;
};
type Events = { cancel: [] };

/** Mount only while open. Native modality permits other native dialogs above it. */
const Modal: StudioComponent<Props, Events> = component<Props, Events>(
  "Modal",
  (props, emit) => {
    const dialog = ref<HTMLDialogElement>();
    // Setup runs after commit, before this adapter mounts its dialog descendants.
    // Capture here: descendant autoFocus must not replace the original opener.
    const opener = props.returnFocus ?? (document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null);
    let mountedDialog: HTMLDialogElement | undefined;
    let releaseFocus: (() => void) | undefined;
    let disposed = false;
    let wantsOpen = true;
    function focusInitial(node: HTMLDialogElement) {
      const initial = props.initialFocus
        ? node.querySelector<HTMLElement>(props.initialFocus)
        : null;
      (initial || node).focus({ preventScroll: true });
    }
    // Only the root reauthentication modal is blocking; it must open immediately.
    const businessModal = props.blocking ? undefined : createBusinessModal(
      () => dialog.value,
      () => !disposed && wantsOpen,
      focusInitial,
    );
    onMounted(() => {
      const node = dialog.value;
      if (disposed || !node?.isConnected) return;
      mountedDialog = node;
      if (businessModal) businessModal.open();
      else {
        if (!node.open) node.showModal();
        releaseFocus = containModalFocus(node);
        focusInitial(node);
      }
    });
    onBeforeUnmount(() => {
      disposed = true;
      releaseFocus?.();
      businessModal?.dispose();
      // React may already have cleared the ref. Retain the actual opened node.
      if (mountedDialog?.open) mountedDialog.close();
      queueMicrotask(() => {
        // Wait for the parent's inert update/removal, but do not steal focus from
        // a different modal or a new user-selected control during navigation.
        if (!opener?.isConnected || opener.closest("[inert]")) return;
        const active = document.activeElement;
        if (active && active !== document.body && active !== opener &&
            active !== mountedDialog && !mountedDialog?.contains(active)) return;
        opener.focus({ preventScroll: true });
      });
    });
    return () => portal(element(
      "dialog",
      {
        ref: domRef(dialog),
        tabIndex: -1,
        "aria-label": props.label,
        "aria-labelledby": props.labelledBy,
        "aria-describedby": props.describedBy,
        "aria-modal": "true",
        className: classes("shared-modal", props.className),
        onCancel: domEvent((event: Event) => {
          // React portal events still bubble through the component tree. A nested
          // SelectionField cancel belongs to that dialog, never to this owner.
          if (event.target !== event.currentTarget) return;
          // Escape never bypasses owner state; backdrop clicks never dismiss.
          event.preventDefault();
          event.stopPropagation();
          if (!props.blocking) {
            wantsOpen = false;
            businessModal?.close();
            emit("cancel");
          }
        }),
      },
      props.children,
    ));
  },
  {},
);
export default Modal;
