/**
 * Cancellation and timeout plumbing shared by every mobile API call.
 *
 * The LAN client already accepts `AbortSignal`s; this module gives the React
 * layer a single place to create them, abort them on unmount / navigation, and
 * turn a stalled Wi-Fi request into an error state instead of endless loading.
 */

export const REQUEST_TIMEOUT_MS = 15_000;

export interface RequestScope {
  /** Signal to hand to `fetch`; aborted on cancellation or timeout. */
  readonly signal: AbortSignal;
  /** True when the abort came from the timeout rather than an explicit cancel. */
  readonly timedOut: boolean;
  /** Abort the request and release the timeout (idempotent). */
  cancel(): void;
  /** Release the timeout after the request settled (idempotent). */
  dispose(): void;
}

/**
 * Creates a per-request abort scope. Callers dispose it in `finally` when the
 * request settles and cancel it from an effect cleanup, otherwise the timeout
 * timer outlives the request.
 */
export function createRequestScope(timeoutMs: number = REQUEST_TIMEOUT_MS): RequestScope {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const clear = () => clearTimeout(timer);
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    cancel() {
      clear();
      controller.abort();
    },
    dispose() {
      clear();
    },
  };
}

/** True for the DOMException an aborted `fetch` rejects with. */
export function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { name?: string }).name === 'AbortError';
}
