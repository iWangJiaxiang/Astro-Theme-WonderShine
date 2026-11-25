import { nextTick } from "./reactivity";

/** After a focused choice disappears, continue at its neighbour in the updated DOM. */
export function followChoiceChange(origin: HTMLElement, target: () => HTMLElement | null | undefined) {
  if (document.activeElement !== origin) return;
  void nextTick().then(() => {
    const active = document.activeElement;
    if (active !== document.body && active !== origin) return;
    target()?.focus({ preventScroll: true });
  });
}
