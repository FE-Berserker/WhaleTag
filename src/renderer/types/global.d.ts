import type { WhaleApi } from '../../shared/ipc-types';

/**
 * Makes the preload-injected `window.whale` surface known to TypeScript.
 * The value is created in src/main/preload.ts via contextBridge.
 */
declare global {
  interface Window {
    whale: WhaleApi;
  }
}

export {};
