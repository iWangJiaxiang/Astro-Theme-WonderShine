/** Validate the bundle ID used by native thread routes. */
export function threadRouteId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new Error('动态标识格式不正确');
  return /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) ? id.toLowerCase() : id;
}

export function canonicalNativeThreadRoute(id: string, language: string, defaultLanguage: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(language)) throw new Error('动态语言格式不正确');
  return `${language === defaultLanguage ? '' : '/' + language}/threads/${threadRouteId(id)}/`;
}
