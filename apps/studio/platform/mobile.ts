/** Track the visible viewport for shared overlays without blocking user zoom. */
export function installMobileShell(native = true): () => void {
  const mobile = /Android|iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const root = document.documentElement;
  if (native && mobile) {
    root.dataset.nativeMobile = 'true';
    root.dataset.nativePlatform = /Android/.test(navigator.userAgent) ? 'android' : 'ios';
  }
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
