import { validatePath } from './repository';
export function isRepositoryPath(path: string): boolean {
  try { validatePath(path); return true; } catch { return false; }
}
