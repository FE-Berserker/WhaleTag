import './editor.css';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import App from './app';

declare global {
  interface Window {
    // Preferred base URL for Excalidraw's runtime assets. Script/chunk loading
    // uses the extension protocol directly; font fetch currently falls back to
    // system fonts because whale-extension does not enable supportFetchAPI
    // (the upstream CDN fallback is blocked by CSP). See docs/07 §6.
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

window.EXCALIDRAW_ASSET_PATH = 'whale-extension://excalidraw-editor/';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(createElement(App));
}
