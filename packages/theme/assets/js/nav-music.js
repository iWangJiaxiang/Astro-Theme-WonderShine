/* Keep the persisted navigation player idle until the visitor asks to play. */
(() => {
  const pending = new WeakMap();
  let styles;
  window.ensureNavMusic = function () {
    const element = document.querySelector('#nav-music meting-js');
    if (!element) return Promise.reject(new Error('Navigation music is unavailable'));
    if (element.aplayer) return Promise.resolve(element.aplayer);
    if (pending.has(element)) return pending.get(element);
    const request = (async () => {
      if (!document.querySelector('link[href="/libs/aplayer/APlayer.min.css"]')) {
        styles ||= getCSS('/libs/aplayer/APlayer.min.css', 'nav-music-styles').catch(error => { styles = undefined; throw error; });
        await styles;
      }
      if (!window.APlayer) await getScript('/libs/aplayer/APlayer.min.js');
      if (!window.customElements.get('meting-js')) await getScript('/libs/aplayer/Meting2.min.js');
      if (!element.isConnected) throw new Error('Navigation music was removed');
      if (element.aplayer) return element.aplayer;
      return new Promise((resolve, reject) => {
        const finish = error => {
          clearTimeout(timer);
          element.removeEventListener('meting:ready', ready);
          element.removeEventListener('meting:error', failed);
          element.removeEventListener('meting:removed', failed);
          if (error) reject(error); else resolve(element.aplayer);
        };
        const ready = () => finish();
        const failed = () => finish(new Error('The playlist could not be loaded'));
        const timer = setTimeout(failed, 30000);
        element.addEventListener('meting:ready', ready, { once: true });
        element.addEventListener('meting:error', failed, { once: true });
        element.addEventListener('meting:removed', failed, { once: true });
        element._activated = true;
        element.connectedCallback();
        if (element.aplayer) ready();
      });
    })();
    pending.set(element, request);
    request.finally(() => pending.delete(element)).catch(() => {});
    return request;
  };
})();
