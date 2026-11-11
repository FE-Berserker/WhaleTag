export interface ViewerPrefs {
  getPref: (key: string) => string | null;
  setPref: (key: string, value: string) => void;
}

/**
 * Create namespaced localStorage accessors for an extension viewer.
 *
 * Storage can be unavailable in a sandboxed iframe (including the
 * `window.localStorage` getter itself throwing), so reads fall back to null
 * and writes silently degrade, matching the viewers' previous behavior.
 */
export function createViewerPrefs(prefix: string): ViewerPrefs {
  return {
    getPref(key: string): string | null {
      try {
        return window.localStorage.getItem(prefix + key);
      } catch {
        return null;
      }
    },
    setPref(key: string, value: string): void {
      try {
        window.localStorage.setItem(prefix + key, value);
      } catch {
        // Sandbox may disable localStorage; silently degrade.
      }
    },
  };
}
