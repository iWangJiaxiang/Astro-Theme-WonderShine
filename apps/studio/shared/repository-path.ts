import { validateRepositoryPath } from './repository';
export function isRepositoryPath(path: string): boolean {
  try { validateRepositoryPath(path); return true; } catch { return false; }
}
