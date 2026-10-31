/** Site content contracts shared by the Astro renderer and content adapters. */
export type ContentKind = 'article' | 'note' | 'topic' | 'page' | 'section';
export type DataRecord = Record<string, any>;

export interface TocEntry {
  id: string;
  title: string;
  level: number;
  permalink: string;
  children: TocEntry[];
}

export interface Document {
  id: string;
  relativePath: string;
  /** Canonical public pathname, with a leading and trailing slash. */
  path: string;
  url: string;
  lang: string;
  title: string;
  description: string;
  date?: string;
  updated?: string;
  draft: boolean;
  extra: DataRecord;
  taxonomies: Record<string, string[]>;
  body: string;
  html: string;
  toc: TocEntry[];
  aliases: string[];
  translations: Document[];
  kind: ContentKind;
  layout?: string;
  slug: string;
  weight: number;
  render: boolean;
  transparent: boolean;
  paginateBy: number;
  childLayout?: string;
  parent?: string;
  ancestors: string[];
  frontmatter: DataRecord;
  /** Public paths of colocated assets, copied by the Astro asset build. */
  assets: ContentAsset[];
  wordCount: number;
  readingTime: number;
}

export interface ContentAsset {
  source: string;
  path: string;
}

export interface Site {
  root: string;
  config: DataRecord;
  data: DataRecord;
  localizedData: Record<string, DataRecord>;
  documents: Document[];
  sections: Document[];
  languages: string[];
  defaultLanguage: string;
  assets: ContentAsset[];
}
