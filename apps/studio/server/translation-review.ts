import { parse } from 'smol-toml';
import type { Json } from '../shared/types.js';
import { translationTextChanged } from '../shared/translation.js';
import { getValue, splitDocument } from './content.js';
import { StudioError } from './errors.js';

export function translationReviewChanges(text: string | undefined, changes: Record<string, Json>, body: string): Record<string, Json> {
  const doc = text ? splitDocument(text) : { header: '', body: '' };
  const metadata = parse(doc.header);
  const source = getValue(metadata, 'extra.translation_source');
  if (source && changes['extra.translation_source'] !== undefined && changes['extra.translation_source'] !== source) throw new StudioError(400, '原文文件位置由系统维护，不能修改');
  const tracked = getValue(metadata, 'extra.ai_translation') === true || !!getValue(metadata, 'extra.translation_source')
    || getValue(metadata, 'extra.translation_reviewed') === false || changes['extra.ai_translation'] === true;
  if (!tracked) return changes;
  const changed = translationTextChanged(metadata as Record<string, Json>, { ...metadata, ...changes } as Record<string, Json>, doc.body, body);
  const reviewed = changes['extra.translation_reviewed'] === true || (!changed && changes['extra.translation_reviewed'] !== false && getValue(metadata, 'extra.translation_reviewed') === true);
  if (!(changes.draft ?? metadata.draft ?? true) && !reviewed) throw new StudioError(400, '请先审核译文，再发布内容');
  return { ...changes, 'extra.translation_reviewed': reviewed };
}
