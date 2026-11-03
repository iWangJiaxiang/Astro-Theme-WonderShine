import type {DataRecord,Document} from './types';

export function commentsEnabled(config:DataRecord,document?:Pick<Document,'extra'>):boolean {
  return Boolean(config.extra.comments?.enable && !document?.extra.disable_comment);
}

// Keep this aligned with the layouts that include Comments, not the SDK readiness.
export function hasCommentArea(pageType:string,config:DataRecord,document?:Pick<Document,'extra'>):boolean {
  if (!commentsEnabled(config,document)) return false;
  if (pageType==='links') return config.extra.friend?.enable_comment !== false;
  if (pageType==='equipment') return true;
  return Boolean(document && ['post','thread','collection-detail','collection-content'].includes(pageType));
}
