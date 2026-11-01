/** Apply native touch ergonomics without restricting zoom in the web edition. */
export function installMobileShell(): () => void {
  const mobile = /Android|iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!mobile) return () => {};
  const root = document.documentElement;
  root.dataset.nativeMobile = 'true';
  const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  const previous = viewport?.content;
  if (viewport) viewport.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
  const update = () => {
    const view = window.visualViewport;
    root.style.setProperty('--native-visible-height', `${view?.height ?? innerHeight}px`);
    root.style.setProperty('--native-visible-top', `${view?.offsetTop ?? 0}px`);
  };
  const preventZoom = (event: Event) => event.preventDefault();
  // WebKit gesture events suppress pinch zoom without cancelling scrolling or selection.
  document.addEventListener('gesturestart', preventZoom, { passive: false });
  document.addEventListener('gesturechange', preventZoom, { passive: false });
  window.visualViewport?.addEventListener('resize', update);
  window.visualViewport?.addEventListener('scroll', update);
  window.addEventListener('resize', update);
  update();
  return () => {
    delete root.dataset.nativeMobile;
    if (viewport && previous !== undefined) viewport.content = previous;
    document.removeEventListener('gesturestart', preventZoom);
    document.removeEventListener('gesturechange', preventZoom);
    window.visualViewport?.removeEventListener('resize', update);
    window.visualViewport?.removeEventListener('scroll', update);
    window.removeEventListener('resize', update);
    root.style.removeProperty('--native-visible-height');
    root.style.removeProperty('--native-visible-top');
  };
}
