/** Track the visible viewport for shared overlays without blocking user zoom. */
export function installMobileShell(native = true): () => void {
  const mobile = /Android|iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const root = document.documentElement;
  if (native && mobile) {
    root.dataset.nativeMobile = 'true';
    root.dataset.nativePlatform = /Android/.test(navigator.userAgent) ? 'android' : 'ios';
  }
  // Keyboard navigation keeps its focus ring. A dialog or route that moves
  // focus after a tap should not paint an unrelated control as selected.
  let pointerTarget: EventTarget | null = null;
  let keyboard = false;
  let automatic: HTMLElement | null = null;
  const clearRing = () => { automatic?.removeAttribute('data-auto-focus'); automatic = null; };
  const onPointer = (event: PointerEvent) => { keyboard = false; pointerTarget = event.target; clearRing(); };
  const onKey = () => { keyboard = true; pointerTarget = null; clearRing(); };
  const onFocus = (event: FocusEvent) => {
    clearRing();
    if (keyboard || !(event.target instanceof HTMLElement) || pointerTarget instanceof Node && event.target.contains(pointerTarget)) return;
    automatic = event.target;
    automatic.setAttribute('data-auto-focus', '');
  };
  document.addEventListener('pointerdown', onPointer, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('focusin', onFocus, true);
  const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  const previous = viewport?.content;
  if (native && mobile && viewport) viewport.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
  const update = () => {
    const view = window.visualViewport;
    root.style.setProperty('--native-visible-height', `${view?.height ?? innerHeight}px`);
    root.style.setProperty('--native-visible-top', `${view?.offsetTop ?? 0}px`);
    root.style.setProperty('--studio-visible-width', `${view?.width ?? innerWidth}px`);
    root.style.setProperty('--studio-visible-left', `${view?.offsetLeft ?? 0}px`);
    root.toggleAttribute('data-compact-viewport', (view?.height ?? innerHeight) < 360);
  };
  window.visualViewport?.addEventListener('resize', update);
  window.visualViewport?.addEventListener('scroll', update);
  window.addEventListener('resize', update);
  update();
  return () => {
    clearRing();
    document.removeEventListener('pointerdown', onPointer, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('focusin', onFocus, true);
    delete root.dataset.nativeMobile;
    delete root.dataset.nativePlatform;
    root.removeAttribute('data-compact-viewport');
    if (viewport && previous !== undefined) viewport.content = previous;
    window.visualViewport?.removeEventListener('resize', update);
    window.visualViewport?.removeEventListener('scroll', update);
    window.removeEventListener('resize', update);
    root.style.removeProperty('--native-visible-height');
    root.style.removeProperty('--native-visible-top');
    root.style.removeProperty('--studio-visible-width');
    root.style.removeProperty('--studio-visible-left');
  };
}
