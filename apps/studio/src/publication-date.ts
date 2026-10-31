import { dateParts } from '../shared/form-fields';

export interface PublicationDateDraft { date: string; time: string; zone: string }
export function publicationDateDraft(value: string): PublicationDateDraft {
  const parts = dateParts(value);
  return { date: parts?.date || '', time: parts?.time || '00:00:00', zone: parts?.zone?.toUpperCase() || 'Z' };
}
export function publicationDateValue(draft: PublicationDateDraft): string | null {
  if (!draft.date || !draft.time || !/^(Z|[+-]\d{2}:\d{2})$/.test(draft.zone)) return null;
  const time = /^\d{2}:\d{2}$/.test(draft.time) ? `${draft.time}:00` : draft.time;
  const value = `${draft.date}T${time}${draft.zone}`;
  return dateParts(value) && /^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(time) ? value : null;
}
