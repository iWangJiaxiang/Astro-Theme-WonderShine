// The native runtime owns the secret; the UI can replace it only for the active checkout.
export const nativeGitCredential: { current?: { id: string; hasToken: () => boolean; set: (value: string) => Promise<void> } } = {};
