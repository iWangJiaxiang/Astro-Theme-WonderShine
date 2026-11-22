// A classic script runs before the first paint, including the native connection screen.
(() => {
  let scheme;
  try {
    scheme = localStorage.getItem('studio-site-scheme');
    const stored = localStorage.getItem('studio-appearance');
    const override = stored === null ? localStorage.getItem('studio-theme') : JSON.parse(stored)?.['extra.style.color_scheme'];
    if (override === 'dark' || override === 'light' || override === 'system') scheme = override;
  } catch { /* The system preference also works without storage. */ }
  document.documentElement.dataset.theme = scheme === 'dark' || (scheme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
})();
