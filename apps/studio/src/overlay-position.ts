/** Position a non-modal popup inside the visible (keyboard/zoom) viewport. */
export function overlayPosition(
  anchor: { top: number; bottom: number; right: number },
  panel: { width: number; height: number },
  viewport: { left: number; top: number; width: number; height: number },
  gap = 8,
): { top: number; left: number } {
  const left = viewport.left + gap;
  const top = viewport.top + gap;
  const right = viewport.left + viewport.width - gap;
  const bottom = viewport.top + viewport.height - gap;
  const below = anchor.bottom + gap;
  return {
    top: below + panel.height <= bottom
      ? Math.max(top, below)
      : Math.max(top, Math.min(anchor.top - panel.height - gap, bottom - panel.height)),
    left: Math.max(left, Math.min(anchor.right - panel.width, right - panel.width)),
  };
}
