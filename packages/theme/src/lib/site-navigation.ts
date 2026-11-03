import { localizeConfig, localizeData, localeHome, t } from './locale';
import { navigationMenus } from './navigation';
import type { Site } from './types';

export function siteNavigation(site: Site, lang: string) {
  const config = localizeConfig(site, lang);
  const data = localizeData(site, lang);
  const defaults = config.extra.activity?.enable ? ['threads', 'timeline'].map(key => ({
    name: t(key, lang, site, 'activity'),
    href: `${localeHome(lang, site)}${key}/`,
  })) : [];
  return navigationMenus(data.menu?.nav_menu || [], defaults, site.languages);
}
