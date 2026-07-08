import './editor.css';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import App from './app';

declare global {
  interface Window {
    // Excalidraw resolves its fonts / worker chunks relative to this base URL at
    // runtime. Set before the component renders so the offline copies served
    // under this extension's folder are used (see build-extensions.js).
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

window.EXCALIDRAW_ASSET_PATH = 'whale-extension://excalidraw-editor/';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(createElement(App));
}
