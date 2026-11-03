import type { WorkspaceStatus } from './workspace.js';

export const workspaceChanged = '工作区已变化，请刷新并重新确认提交范围';

/** Include file bytes, not just Git status flags: a second edit can have identical flags. */
export async function workspaceConfirmation(
  branch: string, head: string | null, rows: Array<[string, number, number, number]>,
  read: (path: string) => Promise<Uint8Array>,
): Promise<string> {
  const digest = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))), byte => byte.toString(16).padStart(2, '0')).join('');
  const files = [];
  for (const row of rows) files.push([...row, row[2] ? await digest(await read(row[0])) : null]);
  return digest(new TextEncoder().encode(JSON.stringify([branch, head, files])));
}

export function confirmationMatches(expected: unknown, status: WorkspaceStatus): boolean {
  return typeof expected === 'string' && expected === status.confirmation;
}
