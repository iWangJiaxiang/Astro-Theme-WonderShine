type Position = { x: number; y: number; focus: HTMLElement | null };

/** Keep viewport context in memory only; never put editor data into history/URLs. */
export function navigationPosition() {
  const positions = new Map<string, Position>();
  let cancelPending = () => {};
  return {
    remember(key: string) {
      // Viewport memory is small and bounded even in long editing sessions. The
      // page being left always becomes the newest entry before opening another.
      positions.delete(key);
      positions.set(key, { x: window.scrollX, y: window.scrollY, focus: document.activeElement instanceof HTMLElement ? document.activeElement : null });
      if (positions.size > 64) positions.delete(positions.keys().next().value!);
    },
    enter(key: string, restore = false) {
      cancelPending();
      const saved = restore ? positions.get(key) : undefined;
      let frame = 0, cancelled = false;
      const observer = new MutationObserver(() => schedule());
      const stop = () => {
        cancelled = true;
        window.cancelAnimationFrame(frame);
        observer.disconnect();
        window.removeEventListener('wheel', stop);
        window.removeEventListener('touchstart', stop);
        window.removeEventListener('pointerdown', stop);
        window.removeEventListener('keydown', stop);
        window.removeEventListener('focusin', focusIntent, true);
      };
      const focusIntent = (event: FocusEvent) => {
        const target = event.target;
        if (target instanceof HTMLElement && target.closest('.main-content') && !target.closest('[inert]') &&
          (target.isContentEditable || target.matches('input, button, select, textarea, a[href], summary, [tabindex]'))) stop();
      };
      const place = () => {
        if (cancelled) return;
        const main = document.querySelector<HTMLElement>('.main-content');
        const heading = main?.querySelector<HTMLElement>('h1');
        // Controllers mount after commit; async settings/editor headings arrive
        // later still. Wait for the destination, not a loading skeleton.
        if (!heading || main?.querySelector('.loading-panel') || document.querySelector('dialog[open]')) return;
        if (saved && document.documentElement.scrollHeight - innerHeight + 1 < saved.y) return;
        const target = saved?.focus?.isConnected && !saved.focus.closest('[inert]') ? saved.focus : heading;
        // Our own heading/saved-control focus must not count as new input intent.
        stop();
        if (!target.matches('button, a[href], input, select, textarea, [tabindex]')) target.tabIndex = -1;
        target.focus({ preventScroll: true });
        window.scrollTo(saved?.x ?? 0, saved?.y ?? 0);
      };
      const schedule = () => {
        if (cancelled) return;
        window.cancelAnimationFrame(frame);
        frame = window.requestAnimationFrame(place);
      };
      // Readiness, not elapsed time, owns restoration. Slow successful reads
      // must behave like fast ones; input/navigation/session/unmount cancel it.
      observer.observe(document.getElementById('app') || document.body, { childList: true, subtree: true });
      window.addEventListener('wheel', stop, { passive: true });
      window.addEventListener('touchstart', stop, { passive: true });
      window.addEventListener('pointerdown', stop, { passive: true });
      window.addEventListener('keydown', stop);
      window.addEventListener('focusin', focusIntent, true);
      cancelPending = stop;
      schedule();
    },
    clear() { cancelPending(); positions.clear(); },
    dispose() { cancelPending(); positions.clear(); },
  };
}
