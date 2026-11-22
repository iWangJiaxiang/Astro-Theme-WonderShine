import type { Message } from '../shared/i18n';
import type { AccountProvider, ProviderAccount } from './provider-auth';

export interface WorkspaceOAuthCredential {
  provider: AccountProvider;
  authorize: (account: ProviderAccount) => Promise<void>;
}

// The native runtime owns the secret; the UI can replace it only for the active checkout.
export const nativeGitCredential: { current?: {
  id: string;
  hasToken: () => boolean;
  set: (value: string) => Promise<void>;
  oauth?: WorkspaceOAuthCredential;
} } = {};

export function isGitAuthFailure(message: Message) {
  return typeof message === 'object' && (message.params?.gitAuth === 1
    || /\/Auth$/.test(String(message.params?.gitDetail))
    || /授权|重新登录/.test(message.key));
}
