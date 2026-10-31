export const autosaveIntervals = [0, 30, 300, 1800] as const;
export const autosaveCookie = 'studio-autosave';
export function parseAutosave(value: string): number {
  const seconds = Number(value);
  return autosaveIntervals.some(item => item === seconds) ? seconds : 0;
}
export function readAutosave(cookie: string): number {
  const value = cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${autosaveCookie}=`))?.slice(autosaveCookie.length + 1);
  return value ? parseAutosave(value) : 0;
}
export function writeAutosave(seconds: number, secure: boolean): string {
  return `${autosaveCookie}=${parseAutosave(String(seconds))}; Path=/; Max-Age=31536000; SameSite=Strict${secure ? '; Secure' : ''}`;
}
export interface AutosaveState { ready: boolean; dirty: boolean; busy: boolean; blocked: boolean; authenticated: boolean }
export function canAutosave(state: AutosaveState): boolean {
  return state.ready && state.dirty && !state.busy && !state.blocked && state.authenticated;
}
