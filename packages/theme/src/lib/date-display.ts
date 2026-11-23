export function utcDateTitle(date?: string | Date): string | undefined {
  if (!date) return;
  const value = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(value.getTime())) return;
  return value.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}
