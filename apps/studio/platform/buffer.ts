import { Buffer } from 'buffer';
// isomorphic-git's ESM build expects Buffer even in a browser/WebView.
// This is a byte-array polyfill, not a Node runtime or a backend process.
const runtime = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
if (!runtime.Buffer) runtime.Buffer = Buffer;
