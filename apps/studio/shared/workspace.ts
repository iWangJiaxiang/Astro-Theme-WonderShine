import type { BranchFile, BranchSave } from './save.js';
import type { ThemeCommit } from './theme-update.js';
export type MergeChoices = Record<string, 'local' | 'remote'>;
export interface MergeFile { path: string; local: boolean; remote: boolean }
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
  canPublish?: boolean;
  canMerge?: boolean;
  canUncommit?: boolean;
  canDiscard?: boolean;
  canResolveMerge?: boolean;
  mergeFiles?: MergeFile[];
  discardPaths?: string[];
  managedChanges?: string[];
  /** Present only on explicit createReview(), never status/commit/sync responses. */
  confirmation?: string;
  confirmationExpiresAt?: number;
}

/** Save, local commit, and remote synchronization are distinct operations. */
export interface WorkspaceControl {
  /** False for a local checkout without a usable sync remote. */
  readonly canSync?: boolean;
  /** Commit the confirmed theme change on the configured branch, scoped to exact config blobs. */
  commitTheme?(change: ThemeCommit): Promise<string>;
  reviewMerge?(): Promise<WorkspaceStatus>;
  resolveMerge?(confirmation: string, choices: MergeChoices): Promise<WorkspaceStatus>;
  reviewUncommit?(): Promise<WorkspaceStatus>;
  uncommit?(confirmation: string): Promise<WorkspaceStatus>;
  reviewDiscard?(): Promise<WorkspaceStatus>;
  discard?(confirmation: string): Promise<WorkspaceStatus>;
  publish?(message: string, confirmation: string): Promise<void>;
  saveBranch?(key: string, files: BranchFile[]): Promise<BranchSave>;
  checkRemote?(): Promise<Pick<WorkspaceStatus, 'ahead' | 'behind'>>;
  status(): Promise<WorkspaceStatus>;
  /** Explicit user review; captures exact managed bytes under the workspace lock. */
  createReview(): Promise<WorkspaceStatus>;
  /** Optional only for trusted internal/test callers. HTTP/native transports must require a nonempty token.
   * Validate the supplied disk snapshot under the lock; never create a token during mutation.
   * Commit returns no token. Sync after committing requires a separate explicit review. */
  commit(message: string, confirmation?: string): Promise<WorkspaceStatus>;
  /** The next explicit review will read post-commit status under a new lock. */
  commitForReview?(message: string, confirmation: string): Promise<void>;
  /** Same internal-only omission policy as commit; user-facing callers must supply confirmation. */
  sync(confirmation?: string): Promise<WorkspaceStatus>;
}

export function workspaceCapabilities(workspace?: WorkspaceControl) {
  return {
    workspace: !!workspace,
    workspaceCanSync: !!workspace && workspace.canSync !== false,
    quickSync: !!workspace?.checkRemote,
  };
}
