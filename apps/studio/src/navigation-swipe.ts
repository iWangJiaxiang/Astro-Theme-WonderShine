// Limit horizontal navigation to the screen edge and bottom navigation.
// Fields and scrolling content keep their normal selection, zoom and pan gestures.
type Swipe = 'back' | 'previous' | 'next';

export function installNavigationSwipe(
  enabled: () => boolean,
  canGoBack: () => boolean,
  navigate: (action: Swipe) => void,
) {
  let start: { x: number; y: number; id: number; area: 'edge' | 'tabs' } | undefined;
  const reset = () => { start = undefined; };
  const available = () => enabled() && (window.visualViewport?.scale ?? 1) === 1 &&
    !document.querySelector('dialog[open], .save-mode-menu');
  function begin(event: TouchEvent) {
    reset();
    if (event.touches.length !== 1 || !(event.target instanceof Element) || !available()) return;
    const target = event.target;
    if (!target.closest('.studio-shell') || target.closest('input, select, textarea, [contenteditable=true], .vditor')) return;
    if (window.getSelection()?.isCollapsed === false) return;
    const touch = event.touches[0];
    const area = target.closest('.mobile-tabbar') ? 'tabs'
      : touch.clientX <= 24 && canGoBack() ? 'edge' : undefined;
    if (area) start = { x: touch.clientX, y: touch.clientY, id: touch.identifier, area };
  }
  function move(event: TouchEvent) {
    if (!start) return;
    const touch = event.touches[0];
    if (event.touches.length !== 1 || touch.identifier !== start.id) return reset();
    const dx = Math.abs(touch.clientX - start.x), dy = Math.abs(touch.clientY - start.y);
    if (dy > 10 && dy >= dx) return reset();
    if (dx > 10 && dx > 2 * dy && event.cancelable) event.preventDefault();
  }
  function end(event: TouchEvent) {
    const origin = start;
    reset();
    if (!origin || event.touches.length || !available()) return;
    const touch = event.changedTouches[0];
    if (!touch || touch.identifier !== origin.id) return;
    const dx = touch.clientX - origin.x, dy = touch.clientY - origin.y;
    if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 2) return;
    const action = origin.area === 'tabs' ? (dx < 0 ? 'next' : 'previous')
      : origin.area === 'edge' && dx > 0 && canGoBack() ? 'back' : undefined;
    if (!action) return;
    if (event.cancelable) event.preventDefault();
    navigate(action);
  }
  document.addEventListener('touchstart', begin, { passive: true });
  document.addEventListener('touchmove', move, { passive: false });
  document.addEventListener('touchend', end, { passive: false });
  document.addEventListener('touchcancel', reset);
  return () => {
    document.removeEventListener('touchstart', begin);
    document.removeEventListener('touchmove', move);
    document.removeEventListener('touchend', end);
    document.removeEventListener('touchcancel', reset);
  };
}
