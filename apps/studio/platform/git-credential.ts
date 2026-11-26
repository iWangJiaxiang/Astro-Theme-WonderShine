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
  if (typeof message === 'string') return message === '授权已过期，请重新登录';
  return message.params?.gitAuth === 1
    || /\/Auth$/.test(String(message.params?.gitDetail))
    || message.key === '仓库授权失败，请重新登录或更新访问令牌'
    || message.key === '授权已过期，请重新登录';
}
