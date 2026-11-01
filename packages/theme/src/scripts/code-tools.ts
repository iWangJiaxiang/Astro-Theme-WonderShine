type CodeOptions = {enable?: boolean; enable_copy?: boolean; enable_expander?: boolean; enable_line?: boolean; enable_title?: boolean; enable_height_limit?: boolean; prism_limit?: number};
const host = window as Window & {GLOBAL_CONFIG?: {prism?: CodeOptions}};

async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const input = document.createElement('textarea');
    input.value = text; input.style.cssText = 'position:fixed;opacity:0';
    document.body.append(input); input.select();
    const copied = document.execCommand('copy'); input.remove();
    if (!copied) throw new Error('Clipboard unavailable');
  }
}

function syncCodeTheme() {
  const theme = document.documentElement.dataset.theme || 'light';
  document.querySelectorAll<HTMLLinkElement>('link[data-code-theme]').forEach(link => {link.media = link.dataset.codeTheme === theme ? 'all' : 'not all';});
}
new MutationObserver(syncCodeTheme).observe(document.documentElement, {attributes:true, attributeFilter:['data-theme']});
function initializeCodeTools() {
  syncCodeTheme();
  const options = host.GLOBAL_CONFIG?.prism;
  if (!options?.enable) return;
  const chinese = document.documentElement.lang.startsWith('zh');
  for (const code of document.querySelectorAll<HTMLElement>('.post-content pre > code, .note-body pre > code')) {
    const pre = code.parentElement!;
    if (pre.dataset.codeReady) continue;
    pre.dataset.codeReady = 'true';
    const source = code.textContent || '';
    const wrapper = document.createElement('div'); wrapper.className = 'code-toolbar ws-code';
    pre.before(wrapper); wrapper.append(pre);
    pre.classList.add('language-' + (code.dataset.lang || 'plain'));
    const toolbar = document.createElement('div'); toolbar.className = 'ws-code-toolbar';
    const language = document.createElement('span'); language.className = 'ws-code-language';
    language.textContent = options.enable_title ? code.dataset.lang || 'text' : '';
    toolbar.append(language); wrapper.prepend(toolbar);
    const button = (text: string, action: () => void) => {
      const element = document.createElement('button');
      element.type = 'button'; element.textContent = text; element.addEventListener('click', action);
      toolbar.append(element); return element;
    };
    if (options.enable_copy) {
      const label = chinese ? '复制' : 'Copy';
      const copy = button(label, async () => {
        try { await copyText(source); copy.textContent = chinese ? '已复制' : 'Copied'; }
        catch { copy.textContent = chinese ? '复制失败' : 'Copy failed'; }
        setTimeout(() => {if (copy.isConnected) copy.textContent = label;}, 1600);
      });
      copy.dataset.codeCopy = ''; copy.setAttribute('aria-label', chinese ? '复制代码' : 'Copy code');
    }
    if (options.enable_expander) {
      const fold = button('', () => {pre.classList.toggle('ws-code-collapsed'); update();});
      fold.dataset.codeFold = '';
      const update = () => {
        const expanded = !pre.classList.contains('ws-code-collapsed');
        fold.setAttribute('aria-expanded', String(expanded));
        fold.textContent = expanded ? (chinese ? '折叠' : 'Collapse') : (chinese ? '展开' : 'Expand');
      };
      if (options.enable_height_limit && pre.scrollHeight > (options.prism_limit || 330)) pre.classList.add('ws-code-collapsed');
      update();
    }
    if (options.enable_line) {
      pre.classList.add('line-numbers');
      const rows = document.createElement('span'); rows.className = 'line-numbers-rows'; rows.setAttribute('aria-hidden', 'true');
      for (let line = 0; line < source.replace(/\n$/, '').split('\n').length; line++) rows.append(document.createElement('span'));
      code.append(rows);
    }
  }
}

document.addEventListener('astro:page-load', initializeCodeTools);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeCodeTools, {once:true});
else initializeCodeTools();
