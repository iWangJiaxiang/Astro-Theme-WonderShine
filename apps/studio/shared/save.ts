export type SaveMode = 'local' | 'branch' | 'remote';
export interface SaveCapabilities { modes: SaveMode[] }
export interface BranchFile { path: string; data: Uint8Array | null; onlyIfMissing?: boolean }
export interface BranchSave { branch: string; commit: string }
