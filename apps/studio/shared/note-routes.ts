/** Keep existing storage IDs while exposing UUID-shaped public note identifiers. */
export function noteRouteId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new Error('动态标识格式不正确');
  const legacy = /^n_([a-f0-9]{32})$/i.exec(id);
  if (legacy) return legacy[1].toLowerCase().replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  return /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) ? id.toLowerCase() : id;
}

export function canonicalNativeNoteRoute(id: string, language: string, defaultLanguage: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(language)) throw new Error('动态语言格式不正确');
  return `${language === defaultLanguage ? '' : '/' + language}/thread/${noteRouteId(id)}/`;
}

export function legacyNativeNoteRoute(id: string, language: string, defaultLanguage: string): string {
  noteRouteId(id);
  return `${language === defaultLanguage ? '' : '/' + language}/notes/${id}/`;
}
