import type { Repository } from '../shared/repository.js';
import type { FileSnapshot } from '../shared/types.js';

// Always scan fresh text, including inside write guards; never reuse library summaries.
// Only repositories without the optional capability fall back to revision-bearing lists.
export function listRepositoryText(repository: Repository): Promise<Pick<FileSnapshot, 'path' | 'text'>[]> {
  return repository.listForSummary ? repository.listForSummary() : repository.list();
}
