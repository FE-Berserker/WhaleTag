export interface InitialContent {
  path: string;
  content: string;
}

/** One-shot deferred used by Excalidraw's initialData prop. The host may push
 * the same document more than once before React consumes initialData; only the
 * first payload may resolve the initialization promise. Later documents are
 * handled by the normal fileContent/applyScene path after consumption. */
export function createInitialContentDeferred() {
  let settled = false;
  let resolvePromise!: (value: InitialContent) => void;
  const promise = new Promise<InitialContent>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    consumed: false,
    resolve(value: InitialContent): boolean {
      if (settled) return false;
      settled = true;
      resolvePromise(value);
      return true;
    },
  };
}
