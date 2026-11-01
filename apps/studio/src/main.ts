import { createElement, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './style.css';
import './forms.css';
import './composer.css';
import './workspace.css';
import './creation-tools.css';
const NativeShell = lazy(() => import('../platform/NativeShell'));
const native = '__TAURI_INTERNALS__' in window;
createRoot(document.getElementById('app')!).render(native
  ? createElement(Suspense, { fallback: createElement('p', { role: 'status' }, 'Opening Studio…') }, createElement(NativeShell))
  : createElement(App));
