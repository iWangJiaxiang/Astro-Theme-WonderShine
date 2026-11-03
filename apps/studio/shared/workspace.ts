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
  confirmation?: string;
}

/** Save, local commit, and remote synchronization are distinct operations. */
export interface WorkspaceControl {
  saveBranch?(key: string, files: BranchFile[]): Promise<BranchSave>;
  status(): Promise<WorkspaceStatus>;
  /** Optional only for trusted internal/test callers. HTTP/native transports must require a nonempty token.
   * Implementations compare supplied tokens against fresh status inside the workspace lock. */
  commit(message: string, confirmation?: string): Promise<WorkspaceStatus>;
  /** Same internal-only omission policy as commit; user-facing callers must supply confirmation. */
  sync(confirmation?: string): Promise<WorkspaceStatus>;
}
