import { ref } from './reactivity';
import type { SaveCapabilities, SaveMode } from '../shared/save';
export const saveContext = ref({ scope: '', modes: ['local'] as SaveMode[], defaultMode: 'local' as SaveMode });
const key = (scope: string) => 'studio.save-default.v1:' + scope;
export function configureSaving(scope: string, capabilities: SaveCapabilities) {
  let saved: string | null = null;
  try { saved = localStorage.getItem(key(scope)); } catch { /* Preferences remain optional. */ }
  const modes = capabilities.modes;
  saveContext.value = { scope, modes, defaultMode: modes.includes(saved as SaveMode) ? saved as SaveMode : modes[0] };
}
export function rememberSaveMode(mode: SaveMode): boolean {
  if (!saveContext.value.modes.includes(mode)) return false;
  try { localStorage.setItem(key(saveContext.value.scope), mode); }
  catch { return false; }
  saveContext.value = { ...saveContext.value, defaultMode: mode };
  return true;
}
export const saveModeLabel: Record<SaveMode, string> = { local: '本地保存', branch: 'Git 分支保存', remote: '远端保存' };
