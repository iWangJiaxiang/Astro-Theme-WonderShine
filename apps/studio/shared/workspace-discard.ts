import { StudioError } from '../core/errors.js';
import type { ReviewState } from './workspace-confirmation.js';

/** A destructive review covers every visible row and the exact staged index. */
export async function discardState(state: ReviewState, index: Uint8Array): Promise<ReviewState> {
  if (!state.head || state.rows.some(([path]) => path.includes('\\') || path.includes(':') ||
    path.split('/').some(part => !part || ['.', '..', '.git', '.studio-history', '.studio-write-lock'].includes(part.toLowerCase())))) {
    throw new StudioError(409, '此工作区包含无法安全还原的路径，请使用 Git 工具处理。');
  }
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(index)));
  const digest = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
  return { ...state, scope: state.scope + ':discard:' + digest };
}
