/** Content paths have already been validated and always use forward slashes. */
export const posix = {
  dirname(path: string): string {
    const index = path.lastIndexOf('/');
    return index < 0 ? '.' : index === 0 ? '/' : path.slice(0, index);
  },
};

/** Structural equality for the TOML/JSON values supported by the content model. */
export function isDeepStrictEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Date || right instanceof Date) return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => isDeepStrictEqual(value, right[index]));
  }
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key)
    && isDeepStrictEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

/** The revision format matches the existing Node repository SHA-256 digest. */
export async function revisionOf(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hash].map(value => value.toString(16).padStart(2, '0')).join('');
}
