import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { mediaURL, storedMediaPath } from '../shared/media';

export function markdownPreview(source: string, documentPath: string): Document {
  const html = DOMPurify.sanitize(marked.parse(source, { async: false }));
  const document = new DOMParser().parseFromString(html, 'text/html');
  for (const image of document.querySelectorAll('img')) {
    try {
      const path = storedMediaPath(decodeURIComponent(image.getAttribute('src') || ''), 'document', documentPath);
      if (path) image.setAttribute('src', mediaURL(path));
    } catch {
      // An unrecognized image URL keeps its sanitized source.
    }
  }
  return document;
}
