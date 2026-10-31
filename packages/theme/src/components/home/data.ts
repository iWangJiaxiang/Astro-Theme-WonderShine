import type {Site,Document} from '../../lib/types';
import {isPublic,taxonomyDocuments,taxonomyName,taxonomySlug} from '../../lib/queries';
import {localizeData,localizeUrl} from '../../lib/locale';
export function taxonomyTerms(site:Site,lang:string,kind:string,configuredOnly=false) {
  const docs=taxonomyDocuments(site,lang,kind),data=localizeData(site,lang);
  const configured=[...(data.post?.[kind]||[])].sort((a,b)=>(a.index||0)-(b.index||0));
  const terms=[...new Set(docs.flatMap(doc=>doc.taxonomies[kind]||[]))];
  const ordered=[...configured.map(item=>item.id).filter(id=>terms.includes(id)),...(configuredOnly?[]:terms.filter(term=>!configured.some(item=>item.id===term)).sort())];
  return ordered.map(term=>({term,name:taxonomyName(site,kind,term,lang),url:localizeUrl(`/${kind}/${taxonomySlug(site,term)}/`,lang,site),count:docs.filter(doc=>doc.taxonomies[kind]?.includes(term)).length}));
}
export function featuredDocument(site:Site,source:string|undefined,lang:string):Document|undefined {
  if(!source)return;
  const original=site.documents.find(doc=>doc.relativePath===source);
  if(!original)return;
  return [original,...original.translations].find(doc=>doc.lang===lang&&isPublic(doc,site));
}
export function pageNumbers(page:number,pages:number):(number|'…')[] {
  const selected=[...new Set([1,pages,page-2,page-1,page,page+1,page+2])].filter(value=>value>=1&&value<=pages).sort((a,b)=>a-b);
  const output:(number|'…')[]=[];
  selected.forEach((number,index)=>{if(index&&number-selected[index-1]>1)output.push('…');output.push(number)});
  return output;
}
