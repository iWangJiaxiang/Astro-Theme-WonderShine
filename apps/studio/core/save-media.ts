import { parse } from 'smol-toml';
import { lexer, walkTokens } from 'marked';
import { splitDocument } from './content.js';

/** Parse structured values before URLs, preserving spaces and parentheses in file names. */
export function saveMediaValues(path: string, text: string): string[] {
  const values = new Set<string>();
  function strings(value: unknown): void {
    if (typeof value === 'string') values.add(value);
    else if (Array.isArray(value)) value.forEach(strings);
    else if (value && typeof value === 'object') Object.values(value).forEach(strings);
  }
  let body = '';
  if (path.endsWith('.json')) strings(JSON.parse(text));
  else if (path.endsWith('.toml')) strings(parse(text));
  else if (text.startsWith('+++')) {
    const document = splitDocument(text); strings(parse(document.header)); body = document.body;
  } else body = text;
  if (body) walkTokens(lexer(body), token => {
    if (token.type === 'image' || token.type === 'link') values.add(token.href);
    if (token.type === 'html') {
      for (const match of token.text.matchAll(/(?:src|href)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi)) values.add(match[1] ?? match[2] ?? match[3]);
    }
  });
  return [...values];
}
