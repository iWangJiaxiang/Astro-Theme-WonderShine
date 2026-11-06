import type { BranchFile, BranchSave } from './save.js';
/** Offline status reflects the last fetched remote state; it does not contact the network. */
export interface WorkspaceStatus {
  branch: string;
  dirty: boolean;
  changes: number;
  ahead: number;
  behind: number;
  diverged: boolean;
  head: string | null;
  remoteHead: string | null;
  lastSync: string | null;
  canSync?: boolean;
  managedChanges?: string[];
  /** Present only on explicit createReview(), never status/commit/sync responses. */
  confirmation?: string;
  confirmationExpiresAt?: number;
}

/** Save, local commit, and remote synchronization are distinct operations. */
export interface WorkspaceControl {
  saveBranch?(key: string, files: BranchFile[]): Promise<BranchSave>;
  status(): Promise<WorkspaceStatus>;
  /** Explicit user review; captures exact managed bytes under the workspace lock. */
  createReview(): Promise<WorkspaceStatus>;
  /** Optional only for trusted internal/test callers. HTTP/native transports must require a nonempty token.
   * Validate the supplied disk snapshot under the lock; never create a token during mutation.
   * Commit returns no token. Sync after committing requires a separate explicit review. */
  commit(message: string, confirmation?: string): Promise<WorkspaceStatus>;
  /** Same internal-only omission policy as commit; user-facing callers must supply confirmation. */
  sync(confirmation?: string): Promise<WorkspaceStatus>;
}
