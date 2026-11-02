export interface NavigationMenu {
  name: string;
  href?: string;
  target?: string;
  rel?: string;
  icon?: string;
  is_vertical?: boolean;
  menus?: NavigationMenu[];
}

/** Insert missing activity defaults after the first configured menu, without mutating site data. */
export function navigationMenus(
  configured: NavigationMenu[],
  activityDefaults: NavigationMenu[],
  languages: string[] = [],
): NavigationMenu[] {
  const route = (href = '') => {
    if (!href.startsWith('/') || href.startsWith('//')) return href;
    let path = href.split(/[?#]/)[0].replace(/\/+$/, '');
    for (const language of languages) {
      if (path.startsWith(`/${language}/`)) {
        path = path.slice(language.length + 1);
        break;
      }
    }
    return path;
  };
  const destinations = new Set<string>();
  const visit = (menus: NavigationMenu[]) => menus.forEach(menu => {
    if (menu.href) destinations.add(route(menu.href));
    if (menu.menus) visit(menu.menus);
  });
  visit(configured);
  const missing = activityDefaults.filter(menu => !destinations.has(route(menu.href)));
  // An explicitly empty menu remains empty, as before.
  return configured.flatMap((menu, index) => index === 0 ? [menu, ...missing] : [menu]);
}
