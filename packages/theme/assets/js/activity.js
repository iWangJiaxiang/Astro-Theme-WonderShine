/** Filter the complete public set before paging; keep ties stable across navigation. */
export function selectActivity(items, { kind = 'all', page = 1, pageSize = 12, sort = 'published' } = {}) {
  const selectedKind = ['article', 'thread'].includes(kind) ? kind : 'all';
  const size = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : 12;
  const key = sort === 'active' ? 'active' : 'published';
  const matching = items.filter(item => selectedKind === 'all' || item.kind === selectedKind)
    .slice().sort((a, b) => (b[key] - a[key]) || (b.published - a.published) || a.id.localeCompare(b.id));
  const pages = Math.max(1, Math.ceil(matching.length / size));
  const requested = /^\d+$/.test(String(page)) ? Number(page) : 1;
  const current = Math.min(pages, Math.max(1, Number.isSafeInteger(requested) ? requested : 1));
  return { items: matching.slice((current - 1) * size, current * size), all: matching,
    page: current, pages, total: matching.length, kind: selectedKind };
}

if (typeof document !== 'undefined') {
  const controllers = new WeakMap();
  const updateOverflow = node => {
    node.classList.toggle('is-overflowing', node.clientWidth > 0 &&
      (node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1));
  };
  const overflowObserver = typeof ResizeObserver === 'undefined' ? null :
    new ResizeObserver(entries => entries.forEach(entry => updateOverflow(entry.target)));
  const mount = root => {
    const container = root.querySelector('[data-activity-items]');
    if (!container) return;
    // PJAX handles popstate too: every local navigation must use its history schema.
    const historyState = url => ({ url: url.href, title: document.title,
      uid: Date.now(), scrollPos: [window.scrollX, window.scrollY] });
    const clientRouter = !!document.querySelector('meta[name="astro-view-transitions-enabled"]');
    if (!clientRouter && !window.history.state?.url) {
      window.history.replaceState(historyState(new URL(window.location.href)), '', window.location.href);
    }
    const items = [...container.querySelectorAll('[data-activity-item]')].map(node => ({
      node, id: node.dataset.id || '', kind: node.dataset.kind,
      published: Number(node.dataset.published) || 0, active: Number(node.dataset.active) || 0,
    }));
    const pageSize = Number(root.dataset.pageSize) || 12;
    const filters = [...root.querySelectorAll('[data-activity-filter]')];
    const pagination = root.querySelector('[data-activity-pagination]');
    const previous = root.querySelector('[data-activity-previous]');
    const next = root.querySelector('[data-activity-next]');
    const status = root.querySelector('[data-activity-page]');
    const empty = root.querySelector('[data-activity-empty]');
    let result;
    const render = () => {
      const params = new URL(window.location.href).searchParams;
      result = selectActivity(items, { kind: filters.length ? params.get('type') : 'all',
        page: params.get('page') || 1, pageSize, sort: root.dataset.sort });
      const visible = new Set(result.items);
      const matching = new Set(result.all);
      const ordered = [...result.all, ...items.filter(item => !matching.has(item))];
      // Keep existing nodes in place when SSR already emitted the requested order.
      // Moving every card after first paint can reset LCP candidates and shift images.
      for (let index = 0; index < ordered.length; index++) {
        const item = ordered[index];
        item.node.hidden = !visible.has(item);
        if (container.children[index] !== item.node) container.insertBefore(item.node, container.children[index] || null);
      }
      for (const filter of filters) {
        const active = filter.dataset.activityFilter === result.kind;
        filter.classList.toggle('is-active', active);
        filter.setAttribute('aria-pressed', String(active));
        filter.disabled = false;
        filter.closest('nav').hidden = false;
      }
      if (empty) empty.hidden = result.total > 0;
      if (pagination) pagination.hidden = result.pages <= 1;
      if (previous) previous.disabled = result.page <= 1;
      if (next) next.disabled = result.page >= result.pages;
      if (status) status.textContent = `${result.page} / ${result.pages}`;
      root.dataset.ready = 'true';
      root.querySelectorAll('[data-overflow-fade]').forEach(updateOverflow);
    };
    root.addEventListener('click', event => {
      const filter = event.target.closest('[data-activity-filter]');
      const back = event.target.closest('[data-activity-previous]');
      const forward = event.target.closest('[data-activity-next]');
      if (!filter && !back && !forward) return;
      const url = new URL(window.location.href);
      const kind = filter ? filter.dataset.activityFilter : result.kind;
      const page = filter ? 1 : result.page + (forward ? 1 : -1);
      if (kind === 'all') url.searchParams.delete('type'); else url.searchParams.set('type', kind);
      if (page === 1) url.searchParams.delete('page'); else url.searchParams.set('page', String(page));
      if (clientRouter && window.pjax) {window.pjax.loadUrl(url.href); return;}
      window.history.pushState(historyState(url), '', url);
      render();
    });
    controllers.set(root, render);
    render();
  };
  const initialize = () => {
    overflowObserver?.disconnect();
    const body = document.getElementById('body-wrap');
    if (body?.dataset.language) document.documentElement.lang = body.dataset.language;
    for (const root of document.querySelectorAll('[data-activity-list]')) {
      const render = controllers.get(root);
      if (render) render(); else mount(root);
    }
    document.querySelectorAll('[data-overflow-fade]').forEach(node => {
      updateOverflow(node);
      overflowObserver?.observe(node);
    });
  };
  document.addEventListener('DOMContentLoaded', initialize);
  document.addEventListener('pjax:complete', initialize);
  window.addEventListener('popstate', initialize);
  if (document.readyState !== 'loading') initialize();
  document.fonts?.ready.then(() => document.querySelectorAll('[data-overflow-fade]').forEach(updateOverflow));
}
