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
  commit(message: string, confirmation?: string): Promise<WorkspaceStatus>;
  sync(confirmation?: string): Promise<WorkspaceStatus>;
}
