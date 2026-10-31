import type { MediaItem } from '../shared/media';
export interface MediaDirectory { path: string; name: string; count: number; children: MediaDirectory[] }
export function mediaDirectoryTree(items: MediaItem[]): MediaDirectory[] {
  const roots: MediaDirectory[] = [], directories = new Map<string, MediaDirectory>();
  for (const item of items) {
    let parent = roots;
    const parts = item.directory.split('/');
    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i + 1).join('/');
      let node = directories.get(path);
      if (!node) { node = { path, name: parts[i], count: 0, children: [] }; parent.push(node); directories.set(path, node); }
      node.count++; parent = node.children;
    }
  }
  const sort = (nodes: MediaDirectory[]) => { nodes.sort((a, b) => a.name.localeCompare(b.name)); nodes.forEach(node => sort(node.children)); };
  sort(roots); return roots;
}
export function inMediaDirectory(item: MediaItem, directory: string): boolean {
  return !directory || item.directory === directory || item.directory.startsWith(directory + '/');
}
