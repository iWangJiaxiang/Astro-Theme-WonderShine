import { createElement, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installMobileShell } from '../platform/mobile';
import '../platform/mobile.css';
import './style.css';
import './forms.css';
import './composer.css';
import './workspace.css';
import './creation-tools.css';
import './accessibility.css';
const NativeShell = lazy(() => import('../platform/NativeShell'));
const native = '__TAURI_INTERNALS__' in window;
const disposeMobileShell = installMobileShell(native);
import.meta.hot?.dispose(disposeMobileShell);
createRoot(document.getElementById('app')!).render(native
  ? createElement(Suspense, { fallback: createElement('p', { role: 'status' }, 'Opening Studio…') }, createElement(NativeShell))
  : createElement(App));
