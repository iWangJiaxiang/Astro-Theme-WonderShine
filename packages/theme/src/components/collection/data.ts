import type {Document,Site} from '../../lib/types';
import {isPublic} from '../../lib/queries';

export function childSections(site:Site, section:Document, renderedOnly=false):Document[] {
  return site.sections.filter(item=>item.lang===section.lang&&item.parent===section.relativePath&&!item.draft&&(!renderedOnly||isPublic(item,site)))
    .sort((a,b)=>a.weight-b.weight||a.relativePath.localeCompare(b.relativePath));
}
export function sectionPages(site:Site,section:Document):Document[] {
  return site.documents.filter(item=>item.lang===section.lang&&item.parent===section.relativePath&&isPublic(item,site))
    .sort((a,b)=>a.title.localeCompare(b.title,section.lang));
}
export function collectionAncestors(site:Site,doc:Document):Document[] {
  return doc.ancestors.map(source=>site.sections.find(section=>section.relativePath===source&&section.lang===doc.lang))
    .filter((section):section is Document=>Boolean(section&&section.relativePath.startsWith('collections/')&&!/^collections\/_index(?:\.[^/]+)?\.md$/.test(section.relativePath)&&isPublic(section,site)));
}
export function ownerCollection(site:Site,doc:Document):Document {
  return doc.kind==='section'?doc:site.sections.find(section=>section.relativePath===doc.parent&&section.lang===doc.lang)||collectionAncestors(site,doc).at(-1)||doc;
}
