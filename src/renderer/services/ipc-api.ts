import type { WhaleApi } from '../../shared/ipc-types';

/**
 * Typed reference to the preload-injected `window.whale` surface. The
 * `WhaleApi` interface in `src/shared/ipc-types.ts` is the single source of
 * truth — `src/main/ipc.ts` registers handlers, `src/main/preload.ts`
 * implements `const whaleApi: WhaleApi`, and this module exposes the same
 * instance for renderer code. Adding a method to preload + `WhaleApi`
 * automatically makes it available here; no per-method forwarding, so the
 * preload-side signature drift that motivated this rewrite is gone.
 *
 * Throws on first method call (NOT on module import) when the preload
 * bridge is unavailable. Node-only test environments that transitively
 * import this file therefore stay inert until something actually fires an
 * IPC — module-load side effects were historically masked by the lazy
 * `requireApi()` guard in the old hand-rolled wrapper.
 */
export const ipcApi: WhaleApi =
  typeof window !== 'undefined' && window.whale
    ? window.whale
    : makeThrowingProxy();

/**
 * Builds a Proxy shaped like `WhaleApi` that throws on every method access.
 * Lets unit tests that render components without a preload bridge fail at
 * the point of the first IPC call, with a message that names which method
 * was reached for instead of an opaque `undefined is not a function`.
 *
 * Symbol-keyed access (used by `Symbol.toPrimitive`, `Object.keys`, etc.)
 * returns `undefined` so the proxy doesn't trip on language-level
 * introspection that happens during import.
 */
function makeThrowingProxy(): WhaleApi {
  return new Proxy({} as WhaleApi, {
    get(_target, prop) {
      if (typeof prop === 'symbol') return undefined;
      throw new Error(
        `window.whale is undefined — preload bridge not available (running outside Electron?); tried .${prop}()`
      );
    },
  });
}
