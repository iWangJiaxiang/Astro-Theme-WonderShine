// Module scripts run once across Astro navigations. Read each page's own settings.
const configSelector = 'script[data-umami-src]';
let page, previousUrl = document.referrer, seen = new Set();
let observer, overlayObserver;
const clients = new Map();
let installing = Promise.resolve();
const configOf = script => JSON.stringify([script.dataset.umamiSrc, script.dataset.websiteId,
  script.dataset.hostUrl, script.dataset.domains]);

function idle(callback) {
  if (window.requestIdleCallback) window.requestIdleCallback(callback, { timeout: 1000 });
  else setTimeout(callback, 0);
}

async function flush(client) {
  if (!client.sdk || client.sending) return;
  client.sending = true;
  try {
    // Keep requests ordered so the SDK can reuse the returned session cache.
    for (let n = 0; n < 4 && client.pending.length; n++) {
      const record = client.pending.shift();
      await client.sdk.track(defaults => ({ ...defaults, ...record }));
    }
  } catch {
    // A blocked collector must not interrupt navigation.
  } finally {
    client.sending = false;
    if (client.pending.length) idle(() => flush(client));
  }
}

function record(event = {}) {
  const client = page?.client;
  if (!client || client.failed) return;
  client.pending.push({ ...page.context, ...event });
  if (client.sdk) void flush(client);
}

function tracker(config) {
  const key = configOf(config);
  if (clients.has(key)) return clients.get(key);
  const client = { pending: [] };
  clients.set(key, client);
  const install = () => new Promise(resolve => {
    const script = document.createElement('script');
    script.src = config.dataset.umamiSrc;
    script.fetchPriority = 'low';
    for (const field of ['websiteId', 'hostUrl', 'domains']) {
      if (config.dataset[field]) script.dataset[field] = config.dataset[field];
    }
    // Astro sends each PV, including visits completed before this script loads.
    script.dataset.autoTrack = 'false';
    const previous = window.umami;
    // Each localized tracker configuration has its own Umami session and endpoint.
    if (previous && [...clients.values()].some(item => item.sdk === previous)) delete window.umami;
    function finish() {
      client.sdk = window.umami;
      if (!client.sdk?.track) {
        client.failed = true;
        client.pending.length = 0;
      }
      window.umami = page?.client?.sdk || client.sdk || previous;
      resolve();
      void flush(client);
    }
    script.onload = script.onerror = finish;
    document.head.append(script);
  });
  const start = () => idle(() => { installing = installing.then(install); });
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
  return client;
}

function mayObserve() {
  if (document.visibilityState !== 'visible') return false;
  const box = document.getElementById('loading-box');
  if (!box || box.hidden) return true;
  const background = box.querySelector('.loading-bg');
  return box.classList.contains('loaded') && (!background || getComputedStyle(background).visibility === 'hidden');
}

function observeCards() {
  observer?.disconnect();
  const visit = page;
  if (!visit?.client || !visit.surface || !mayObserve() || !window.IntersectionObserver) return;
  observer = new IntersectionObserver((entries, active) => {
    if (observer !== active || visit !== page || !mayObserve()) return;
    for (const { target, intersectionRect } of entries) {
      if (!target.isConnected || !intersectionRect.width || !intersectionRect.height) continue;
      const id = target.dataset.threadId;
      active.unobserve(target);
      if (id && !seen.has(id)) {
        seen.add(id);
        record({ name: 'thread_impression', data: { thread_id: id, surface: visit.surface, lang: visit.lang } });
      }
    }
  }, { threshold: [0, 1e-10] });
  for (const card of document.querySelectorAll('[data-thread-surface] [data-thread-id]')) {
    if (!seen.has(card.dataset.threadId)) observer.observe(card);
  }
}

function mount() {
  if (page?.body === document.body) return;
  const config = document.querySelector(configSelector);
  const surface = document.querySelector('[data-thread-surface]')?.dataset.threadSurface;
  // Timeline filters use a real Astro swap with a different query on the same path.
  if (surface !== 'timeline' || page?.path !== location.pathname) seen = new Set();
  const enabled = Boolean(config?.dataset.umamiSrc && config.dataset.websiteId);
  const context = { url: location.href, title: document.title, referrer: previousUrl };
  page = { body: document.body, path: location.pathname, lang: document.documentElement.lang,
    surface, context };
  previousUrl = location.href;
  observer?.disconnect();
  overlayObserver?.disconnect();
  if (!enabled) return;
  page.client = tracker(config);
  if (page.client.sdk) window.umami = page.client.sdk;
  record();
  observeCards();
  const box = document.getElementById('loading-box');
  if (surface && box) {
    overlayObserver = new MutationObserver(observeCards);
    overlayObserver.observe(box, { attributes: true, attributeFilter: ['hidden', 'class'] });
  }
}

document.addEventListener('astro:before-swap', () => {
  observer?.disconnect();
  overlayObserver?.disconnect();
});
document.addEventListener('astro:page-load', mount);
document.addEventListener('visibilitychange', observeCards);
document.addEventListener('transitionend', event => {
  if (event.target.matches?.('#loading-box .loading-bg') && event.propertyName === 'visibility') observeCards();
});
document.addEventListener('click', event => {
  const el = event.target.closest?.('[data-umami-event]');
  if (!el || !page?.client) return;
  const data = {};
  for (const attr of el.attributes) {
    if (attr.name.startsWith('data-umami-event-')) data[attr.name.slice('data-umami-event-'.length)] = attr.value;
  }
  record({ name: el.dataset.umamiEvent, data });
}, true);
mount();
