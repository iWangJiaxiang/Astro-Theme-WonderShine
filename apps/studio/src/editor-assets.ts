/** Load Vditor icons without its synchronous XHR + inline-script fallback. */
const scriptId = "vditorIconScript";
let loadedScript: HTMLScriptElement | undefined;
let pending: Promise<void> | undefined;

export function prepareEditorIcons(): Promise<void> {
  const source = `${location.origin}/vendor/vditor/dist/js/icons/ant.js`;
  const symbol = document.getElementById("vditor-icon-bold");
  if (loadedScript && symbol) {
    // Vditor.destroy removes the script but retains the SVG sprite. Reattaching
    // the already-executed node restores its marker without executing it twice.
    if (!loadedScript.isConnected) document.head.append(loadedScript);
    return Promise.resolve();
  }
  if (pending) return pending;
  const existing = document.getElementById(scriptId);
  if (
    existing instanceof HTMLScriptElement &&
    existing.src === source &&
    existing.dataset.studioLoaded === "true" &&
    symbol
  ) {
    loadedScript = existing;
    return Promise.resolve();
  }
  // A module refresh may retain a sprite while losing this module's cache.
  // Replace that owned sprite rather than accumulating duplicate symbol IDs.
  symbol?.closest("svg")?.remove();
  existing?.remove();
  const script = document.createElement("script");
  script.id = scriptId;
  script.src = source;
  script.async = true;
  pending = new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      script.onload = null;
      script.onerror = null;
      pending = undefined;
      if (error) {
        script.remove();
        loadedScript = undefined;
        reject(error);
      } else {
        script.dataset.studioLoaded = "true";
        loadedScript = script;
        resolve();
      }
    };
    const fail = () => finish(new Error("编辑器图标加载失败，请重试。"));
    const timeout = setTimeout(fail, 15_000);
    script.onload = () =>
      document.getElementById("vditor-icon-bold") ? finish() : fail();
    script.onerror = fail;
    document.head.append(script);
  });
  return pending;
}
