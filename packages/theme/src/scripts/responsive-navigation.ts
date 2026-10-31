type ThemeWindow = Window & {
  activateDarkMode?: () => void;
  activateLightMode?: () => void;
  saveToLocal?: {get: (key:string) => string | undefined; set: (key:string,value:string,days:number) => void};
  toRandomPost?: () => void;
};
const host = window as ThemeWindow;
let dispose: (() => void) | undefined;
let currentBody: HTMLElement | undefined;
document.addEventListener('astro:before-preparation', () => {
  document.querySelector<HTMLDialogElement>('#sidebar-menus[open]')?.close();
});
document.addEventListener('astro:before-swap', () => {dispose?.(); dispose=undefined;});
document.addEventListener('astro:page-load', () => {
  if (currentBody===document.body) return;
  currentBody=document.body;
  const dialog=document.querySelector<HTMLDialogElement>('[data-responsive-drawer]');
  const trigger=document.querySelector<HTMLButtonElement>('#toggle-menu button');
  if (!dialog || !trigger) return;
  const controller=new AbortController(), options={signal:controller.signal};
  const viewport=matchMedia('(max-width:1023px)');
  let savedOverflow='';
  const themeButtons=[...dialog.querySelectorAll<HTMLButtonElement>('[data-theme-choice]')];
  const updateChoices=() => {
    let system=false;
    try {system=localStorage.getItem('site-theme-system')==='true';} catch {}
    const choice=system?'system':host.saveToLocal?.get('theme') || dialog.dataset.defaultTheme || 'system';
    themeButtons.forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.themeChoice===choice)));
  };
  trigger.addEventListener('click', () => {
    if (dialog.open) return;
    document.querySelectorAll<HTMLDetailsElement>('.nav-language-switch[open],.compact-more[open]').forEach(item=>item.open=false);
    updateChoices(); savedOverflow=document.body.style.overflow;
    document.body.style.overflow='hidden';dialog.showModal();trigger.setAttribute('aria-expanded','true');
  },options);
  dialog.addEventListener('close', () => {document.body.style.overflow=savedOverflow;trigger.setAttribute('aria-expanded','false');},options);
  dialog.querySelector('[data-drawer-close]')?.addEventListener('click',()=>dialog.close(),options);
  dialog.addEventListener('click',event=>{
    if(event.target===dialog){const bounds=dialog.getBoundingClientRect();if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)dialog.close();}
    if(event.target instanceof Element&&event.target.closest('a[href]'))dialog.close();
  },options);
  viewport.addEventListener('change',event=>{if(!event.matches&&dialog.open)dialog.close();},options);
  themeButtons.forEach(button=>button.addEventListener('click',()=>{
    const choice=button.dataset.themeChoice!;
    try {if(choice==='system'){localStorage.removeItem('theme');localStorage.setItem('site-theme-system','true');}else localStorage.removeItem('site-theme-system');}catch{}
    if(choice!=='system')host.saveToLocal?.set('theme',choice,365);
    const dark=choice==='dark'||choice==='system'&&matchMedia('(prefers-color-scheme:dark)').matches;
    if(dark)host.activateDarkMode?.();else host.activateLightMode?.();
    updateChoices();
  },options));
  dialog.querySelector('[data-random-article]')?.addEventListener('click',()=>{dialog.close();host.toRandomPost?.();},options);
  document.addEventListener('click',event=>{
    document.querySelectorAll<HTMLDetailsElement>('.compact-more[open]').forEach(menu=>{if(event.target instanceof Node&&!menu.contains(event.target)||event.target instanceof Element&&event.target.closest('a[href]'))menu.open=false;});
  },options);
  document.addEventListener('keydown',event=>{
    if(event.key==='Escape')document.querySelectorAll<HTMLDetailsElement>('.compact-more[open]').forEach(menu=>{menu.open=false;menu.querySelector<HTMLElement>('summary')?.focus();});
  },options);
  dispose=()=>{if(dialog.open)dialog.close();controller.abort();};
});
