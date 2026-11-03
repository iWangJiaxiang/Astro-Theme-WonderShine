import {navigate} from 'astro:transitions/client';
import type {TransitionBeforePreparationEvent, TransitionBeforeSwapEvent} from 'astro:transitions/client';

type LegacyWindow = Window & {
  pjax?: {loadUrl: (url: string) => void; refresh: () => void};
  GLOBAL_CONFIG?: {loadProgressBar?: boolean};
  ASTRO_ARTICLES?: string[];
  $rightside?: HTMLElement | null;
  Pace?: {restart: () => void; stop: () => void};
  tocbot?: {destroy: () => void};
  typed?: {destroy: () => void};
  artalkItem?: {destroy: () => void};
  walineInstance?: {destroy: () => void};
  initializationRegistry?: Set<string>;
  globalFn?: {pjax?: Record<string, () => void>};
  refreshFn?: () => void;
  runPostAbstract?: () => void;
  toRandomPost?: () => void;
  progressiveLoad?: (image: Element) => void;
  preloader?: {initLoading: () => void; endLoading: () => void};
};
const host = window as LegacyWindow;

// Keep programmatic legacy links on the same router as ordinary anchors.
host.pjax = {loadUrl(url) {if (url) void navigate(url);}, refresh() {}};
let previousScroll = scrollY;
window.addEventListener('scroll', () => {
  const top = scrollY, header = document.getElementById('page-header');
  header?.classList.toggle('nav-fixed', top > 0);
  header?.classList.toggle('nav-visible', top > 0 && top < previousScroll);
  previousScroll = top;
  if (host.$rightside) host.$rightside.style.cssText = top > 0 ? 'opacity:.8;transform:translateX(-58px)' : '';
}, {passive: true});

let loadingNavigation: AbortSignal | undefined;
function finishLoading(signal: AbortSignal) {
  // A superseded request must not dismiss the next navigation's loading screen.
  if (loadingNavigation !== signal) return;
  loadingNavigation = undefined;
  host.preloader?.endLoading();
  host.Pace?.stop();
}

document.addEventListener('astro:before-preparation', event => {
  const navigation = event as TransitionBeforePreparationEvent;
  loadingNavigation = navigation.signal;
  host.preloader?.initLoading();
  if (host.GLOBAL_CONFIG?.loadProgressBar) host.Pace?.restart();
  navigation.signal.addEventListener('abort', () => finishLoading(navigation.signal), {once: true});
  // Handle cancelled navigation and failed requests, including MPA fallback.
  queueMicrotask(() => {if (navigation.defaultPrevented) finishLoading(navigation.signal);});
  const loader = navigation.loader;
  navigation.loader = async () => {
    try {
      await loader();
    } catch (error) {
      finishLoading(navigation.signal);
      throw error;
    } finally {
      if (navigation.defaultPrevented || navigation.signal.aborted) finishLoading(navigation.signal);
    }
  };
});
document.addEventListener('astro:before-swap', event => {
  const transition = event as TransitionBeforeSwapEvent;
  // Keep the overlay above the old snapshot until the destination is painted.
  // Waiting for DOM replacement alone can expose the outgoing transition image.
  void Promise.allSettled([
    transition.viewTransition.updateCallbackDone,
    transition.viewTransition.finished,
  ]).then(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => finishLoading(transition.signal)));
  });
  const incoming = transition.newDocument;
  const next = incoming.documentElement;
  const current = document.documentElement;
  if (current.dataset.theme) next.dataset.theme = current.dataset.theme;
  for (const name of ['color-scheme-dark', 'hide-aside']) next.classList.toggle(name, current.classList.contains(name));
  document.dispatchEvent(new Event('pjax:send'));
  host.tocbot?.destroy();
  host.typed?.destroy();
  host.artalkItem?.destroy();
  host.walineInstance?.destroy();
  host.typed = undefined;
  host.artalkItem = undefined;
  host.walineInstance = undefined;
  host.initializationRegistry?.clear();
  for (const cleanup of Object.values(host.globalFn?.pjax || {})) cleanup();
  if (host.globalFn) host.globalFn.pjax = {};
  // Comment SDKs inject their stylesheet once; preserve it when the head is replaced.
  document.head.querySelectorAll('style').forEach(style => {
    if (/\.twikoo\b|\.tk-comment\b|\.el-input__inner\b/.test(style.textContent || '')) {
      incoming.head.append(style.cloneNode(true));
    }
  });
  document.head.querySelectorAll('link[data-site-vendor]').forEach(link => {
    if (![...incoming.head.querySelectorAll('link')].some(item => item.getAttribute('href') === link.getAttribute('href'))) incoming.head.append(link.cloneNode(true));
  });
  // Prism's SDK autoloader removes its temporary script from document.body on load.
  // Keep pending scripts attached to the current body until that callback finishes.
  const pendingLanguages = [...document.body.querySelectorAll<HTMLScriptElement>(':scope > script[src]')]
    .filter(script => script.async && /\/prism-[\w-]+(?:\.min)?\.js$/.test(new URL(script.src).pathname));
  if (pendingLanguages.length) {
    const swap = transition.swap;
    transition.swap = () => {
      swap();
      for (const script of pendingLanguages) {
        script.dataset.astroExec = '';
        document.body.append(script);
      }
    };
  }
});

let guardedAbstract = false;
let initializedBody: HTMLElement | undefined;
document.addEventListener('astro:page-load', () => {
  // A superseded navigation can finish its scripts after the new page is ready.
  if (initializedBody === document.body) return;
  initializedBody = document.body;
  document.getElementById('loading-box')?.setAttribute('aria-label', document.documentElement.lang.startsWith('zh') ? '页面加载中' : 'Loading page');
  host.$rightside = document.getElementById('rightside');
  previousScroll = scrollY;
  if (!guardedAbstract && host.runPostAbstract) {
    const original = host.runPostAbstract;
    host.runPostAbstract = () => {
      if (['abstract-content','abstract-tag','abstract-intro','abstract-generate','abstract-recommend','abstract-home','abstract-hide'].every(id => document.getElementById(id))) original();
    };
    guardedAbstract = true;
  }
  host.toRandomPost = () => {
    const articles = host.ASTRO_ARTICLES || [];
    if (articles.length) void navigate(articles[Math.floor(Math.random() * articles.length)]);
  };
  host.refreshFn?.();
  document.dispatchEvent(new Event('pjax:complete'));
  document.querySelectorAll<HTMLImageElement>('.progressive-picture .progressive-content').forEach(image => {
    if (image.complete) host.progressiveLoad?.(image);
    else image.addEventListener('load', () => host.progressiveLoad?.(image), {once: true});
  });
  if (!loadingNavigation) {
    host.preloader?.endLoading();
    host.Pace?.stop();
  }
});
