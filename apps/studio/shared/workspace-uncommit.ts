import { StudioError } from '../core/errors.js';
import { workspaceChanged, type WorkspaceReviewAdapter } from './workspace-confirmation.js';
import type { WorkspaceStatus } from './workspace.js';

/** Only refs move. Working files and the index can change independently of this review. */
export async function uncommitWorkspace(status: WorkspaceStatus, scope: string, reviews: WorkspaceReviewAdapter,
  token: string | undefined, moveBranch: (head: string, remote: string) => Promise<void>, refresh: () => Promise<WorkspaceStatus>) {
  const { branch, head, remoteHead, ahead } = status;
  if (!head || !remoteHead || ahead < 1) throw new StudioError(409, workspaceChanged);
  const state = { scope: scope + ':uncommit:' + remoteHead, branch, head, rows: [] };
  if (token === undefined) {
    const review = await reviews.store.createReview(state, reviews.source);
    return { ...status, confirmation: review.confirmation, confirmationExpiresAt: review.expiresAt };
  }
  await reviews.store.validateReview(token, state, reviews.source);
  await moveBranch(head, remoteHead);
  return refresh();
}
