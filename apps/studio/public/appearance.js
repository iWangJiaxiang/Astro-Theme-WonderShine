// A classic script runs before the first paint, including the native connection screen.
(() => {
  let scheme;
  try {
    const override = localStorage.getItem('studio-theme');
    scheme = override === 'dark' || override === 'light' ? override : localStorage.getItem('studio-site-scheme');
  } catch { /* The system preference also works without storage. */ }
  document.documentElement.dataset.theme = scheme === 'dark' || (scheme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
})();
