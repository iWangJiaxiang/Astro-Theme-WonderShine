import {createProvider, SearchSession, type SearchConfig, type SearchPage} from '../components/search/provider';

type SearchWindow = Window & {
  GLOBAL_CONFIG?: {search?: SearchConfig; keyboard?: boolean};
  selectTextNow?: string;
  rm?: {hideRightMenu?: () => void};
};
const host = window as SearchWindow;
let dispose: (() => void) | undefined;
let initializedDialog: HTMLDialogElement | null = null;
document.addEventListener('astro:before-swap', () => {dispose?.(); dispose = undefined; initializedDialog = null;});
document.addEventListener('astro:page-load', () => {
  const dialog = document.querySelector<HTMLDialogElement>('#site-search');
  if (dialog === initializedDialog) return;
  dispose?.();
  initializedDialog = dialog;
  dispose = dialog ? initSearch(dialog) : undefined;
});

function initSearch(dialog: HTMLDialogElement) {
  const listeners = new AbortController();
  const get = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  const input = get<HTMLInputElement>('#search-query');
  const form = get<HTMLFormElement>('.search-form');
  const feedback = get('.search-feedback'), results = get<HTMLOListElement>('#search-results');
  const title = get('.search-state-title'), detail = get('.search-state-detail'), status = get('.search-status');
  const retry = get<HTMLButtonElement>('.search-retry'), clear = get<HTMLButtonElement>('.search-clear'), browse = get<HTMLAnchorElement>('.search-browse');
  const pager = get('.search-pager'), previous = get<HTMLButtonElement>('.search-prev'), next = get<HTMLButtonElement>('.search-next');
  const labels = JSON.parse(dialog.dataset.labels || '{}') as Record<string, string>;
  const label = (key: string, values: Record<string, string | number> = {}) => (labels[key] || key).replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match));
  const session = new SearchSession(createProvider(host.GLOBAL_CONFIG?.search || {engine:''}, dialog.dataset.siteUrl || location.origin));
  let timer: ReturnType<typeof setTimeout> | undefined, query = '', page = 0, opener: HTMLElement | null = null, oldOverflow = '';
  let composing = false;
  const cancel = () => { clearTimeout(timer); session.cancel(); };
  function state(value: 'initial' | 'loading' | 'results' | 'empty' | 'error') {
    dialog.dataset.state = value;
    results.hidden = value !== 'results';
    feedback.hidden = value === 'initial' || value === 'results';
    retry.hidden = browse.hidden = value !== 'error'; pager.hidden = true;
    results.replaceChildren();
    dialog.querySelector('.search-body')!.scrollTop = 0;
    clear.hidden = !input.value;
    get('.search-key-hint').hidden = value !== 'results';
    const key = {initial:'search_ready',loading:'loading',results:'search_matches',empty:'search_no_results',error:'search_error'}[value];
    title.textContent = status.textContent = label(key);
    detail.textContent = value === 'empty' ? label('search_no_results_detail', {query}) : value === 'error' ? label('search_error_detail') : '';
    get('.search-state-icon').textContent = value === 'error' ? '!' : '⌕';
  }
  // Never interpret search index strings as HTML, including highlighted fragments.
  function highlighted(element: HTMLElement, content: string) {
    const lower = content.toLocaleLowerCase(), term = query.toLocaleLowerCase();
    let offset = 0, position = term ? lower.indexOf(term) : -1;
    while (position !== -1) {
      element.append(document.createTextNode(content.slice(offset, position)));
      const mark = document.createElement('mark'); mark.textContent = content.slice(position, position + term.length); element.append(mark);
      offset = position + term.length; position = lower.indexOf(term, offset);
    }
    element.append(document.createTextNode(content.slice(offset)));
  }
  function render(response: SearchPage) {
    state(response.items.length ? 'results' : 'empty');
    for (const item of response.items) {
      const li = document.createElement('li'), link = document.createElement('a');
      link.className = 'search-result'; link.href = item.url;
      for (const [kind, content] of [['title',item.title], ['section',item.section], ['excerpt',item.excerpt]]) {
        if (!content) continue;
        const span = document.createElement('span'); span.className = `search-result-${kind}`; highlighted(span, content); link.append(span);
      }
      li.append(link); results.append(li);
    }
    if (response.items.length) status.textContent = label('search_matches', {count:response.total});
    pager.hidden = response.pages <= 1;
    previous.disabled = page === 0; next.disabled = page + 1 >= response.pages;
    get('.search-page').textContent = label('search_page', {current:page + 1,total:response.pages});
  }
  async function search(targetPage = 0) {
    cancel(); query = input.value.trim(); page = targetPage;
    if (!query) { state('initial'); return; }
    state('loading');
    try { const response = await session.run(query, page); if (response && dialog.open) render(response); }
    catch { if (dialog.open) state('error'); }
  }
  function changed() {
    cancel(); query = input.value.trim(); page = 0;
    if (!query) { state('initial'); return; }
    state('loading');
    if (!composing) timer = setTimeout(() => { void search(); }, 300);
  }
  function open(selected = '') {
    if (dialog.open) return;
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    oldOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    dialog.showModal(); input.focus();
    if (selected) { input.value = selected.slice(0,512); void search(); }
    else if (input.value.trim()) { void search(); }
    else state('initial');
  }
  document.querySelector('#search-button > .search')?.addEventListener('click', () => open());
  document.querySelector('#menu-search')?.addEventListener('click', () => { const selection = host.selectTextNow || window.getSelection()?.toString() || ''; host.rm?.hideRightMenu?.(); open(selection); });
  get('.search-dismiss').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
  dialog.addEventListener('close', () => { cancel(); document.body.style.overflow = oldOverflow; opener?.focus(); });
  input.addEventListener('input', changed);
  input.addEventListener('compositionstart', () => { composing = true; cancel(); });
  input.addEventListener('compositionend', () => { composing = false; changed(); });
  form.addEventListener('submit', event => { event.preventDefault(); if (!composing) void search(); });
  clear.addEventListener('click', () => { input.value = ''; changed(); input.focus(); });
  retry.addEventListener('click', () => { input.focus(); void search(page); });
  previous.addEventListener('click', () => { input.focus(); void search(page - 1); });
  next.addEventListener('click', () => { input.focus(); void search(page + 1); });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); dialog.close(); return; }
    if (event.key === 'Tab') {
      const controls = [...dialog.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled)')].filter(element => element.getClientRects().length > 0);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      return;
    }
    if (event.isComposing || !['ArrowDown','ArrowUp'].includes(event.key)) return;
    const selector = dialog.dataset.state === 'results' ? '.search-result' : '';
    if (!selector) return;
    const links = [...dialog.querySelectorAll<HTMLAnchorElement>(selector)];
    if (!links.length || (document.activeElement !== input && !links.includes(document.activeElement as HTMLAnchorElement))) return;
    event.preventDefault();
    const current = links.indexOf(document.activeElement as HTMLAnchorElement);
    const index = current < 0 ? (event.key === 'ArrowDown' ? 0 : links.length - 1) : (current + (event.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
    links[index].focus();
  });
  document.addEventListener('keydown', event => {
    const target = event.target;
    if (!host.GLOBAL_CONFIG?.keyboard || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || !event.shiftKey || event.key.toLowerCase() !== 's' || target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    event.preventDefault(); open(window.getSelection()?.toString() || '');
  }, {signal: listeners.signal});
  return () => {cancel(); if (dialog.open) dialog.close(); listeners.abort();};
}
