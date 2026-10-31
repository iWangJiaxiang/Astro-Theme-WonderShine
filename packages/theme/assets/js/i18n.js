// Language changes must refresh the entire shell, including widgets outside PJAX.
(() => {
  document.addEventListener('click', (event) => {
    document.querySelectorAll('.nav-language-switch[open]').forEach((menu) => {
      if (!menu.contains(event.target) || event.target.closest('[data-language-switch]')) menu.open = false;
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    document.querySelectorAll('.nav-language-switch[open]').forEach((menu) => {
      menu.open = false;
      menu.querySelector('summary')?.focus();
    });
  });
  let shellLanguage = document.documentElement.lang;
  document.addEventListener('pjax:complete', () => {
    const nextLanguage = document.getElementById('body-wrap')?.dataset.language;
    if (!nextLanguage) return;
    if (nextLanguage !== shellLanguage && !document.querySelector('meta[name="astro-view-transitions-enabled"]')) {
      window.location.reload();
      return;
    }
    document.documentElement.lang = nextLanguage;
    shellLanguage = nextLanguage;
  });
})();
