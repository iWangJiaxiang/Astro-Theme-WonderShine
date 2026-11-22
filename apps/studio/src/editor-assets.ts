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
  pending = loadEditorScript("icons/ant.js", (script) => {
    if (!document.getElementById("vditor-icon-bold")) throw new Error("Missing editor icons");
    script.dataset.studioLoaded = "true";
    loadedScript = script;
  }, scriptId, "编辑器图标加载失败，请重试。").finally(() => {
    pending = undefined;
  });
  return pending;
}

type EditorLanguage = "zh_CN" | "en_US";
type EditorMessages = Window["VditorI18n"];

const languages = new Map<EditorLanguage, Promise<EditorMessages>>();
let activeMessages: EditorMessages | undefined;
let lute: Promise<void> | undefined;

function loadEditorScript<T>(
  path: string,
  read: (script: HTMLScriptElement) => T,
  id?: string,
  failure = "可视化编辑器加载失败，请重试。",
): Promise<T> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${location.origin}/vendor/vditor/dist/js/${path}`;
    script.async = true;
    const finish = () => {
      clearTimeout(timeout);
      script.onload = null;
      script.onerror = null;
    };
    const fail = () => {
      finish();
      script.remove();
      reject(new Error(failure));
    };
    const timeout = setTimeout(fail, 15_000);
    script.onerror = fail;
    script.onload = () => {
      try {
        const value = read(script);
        // Vditor reuses its script markers once the globals are ready.
        if (id) script.id = id;
        else script.remove();
        finish();
        resolve(value);
      } catch {
        fail();
      }
    };
    document.head.append(script);
  });
}

export function prepareEditorLute(): Promise<void> {
  return lute ??= loadEditorScript("lute/lute.min.js", () => {
    if (typeof Lute === "undefined") throw new Error("Missing Lute");
  }, "vditorLuteScript").catch(error => {
    lute = undefined;
    throw error;
  });
}

export function prepareEditorLanguage(language: EditorLanguage): Promise<EditorMessages> {
  const existing = languages.get(language);
  if (existing) return existing;
  const loading = loadEditorScript(`i18n/${language}.js`, () => {
    const messages = window.VditorI18n;
    // Locale scripts write a global. Keep the active editor's language until mount.
    if (activeMessages) window.VditorI18n = activeMessages;
    if (!messages) throw new Error("Missing Vditor locale");
    return messages;
  }).catch(error => {
    languages.delete(language);
    throw error;
  });
  languages.set(language, loading);
  return loading;
}

export function activateEditorLanguage(messages: EditorMessages): EditorMessages {
  activeMessages = messages;
  return messages;
}
