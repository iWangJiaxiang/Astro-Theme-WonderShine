import type { SaveResult } from './types.js';

export type ThemeChannel = 'latest' | 'next' | 'canary';

export interface ThemeUpdateCheck {
  revision: string | null;
  channel: ThemeChannel;
  pinned: boolean;
  currentVersion: string | null;
  channelVersion: string;
  destination: 'file' | 'workspace' | 'remote';
}

export interface ThemeUpdateResult extends SaveResult {
  pinnedThemeVersion?: string;
  localCommitPending?: boolean;
}

export interface ThemeCommit {
  head: string;
  before: string | null;
  after: string;
  message: string;
}
