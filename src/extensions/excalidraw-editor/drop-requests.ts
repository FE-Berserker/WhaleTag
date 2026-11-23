/**
 * Drop-position bookkeeping for the Excalidraw editor's linked thumbnail
 * embeds.
 *
 * Dropping a non-image file on the canvas posts `requestFileEmbed` and waits
 * for the host's `fileEmbed` reply, which carries the thumbnail. The scene
 * coordinates of the drop have to survive that round trip. The old code kept
 * a single `pendingDropRef` slot: two drops within one thumbnail generation
 * made the first reply land on the second drop's coordinates, and the second
 * reply (the slot already consumed) fell back to the default spot.
 *
 * Each drop now gets a `requestId`; the reply is placed only while that id is
 * pending. Uncorrelated replies (legacy host: no id) are accepted only when
 * nothing else is in flight — otherwise the position would be a guess.
 */
import {
  createPendingRequestRegistry,
  type PendingRequestRegistry,
} from '../../shared/extension-requests';

export interface DropPoint {
  x: number;
  y: number;
}

export type DropRejection =
  /** No request is pending for this id: a late reply, or an id we never sent. */
  | 'unknown-request'
  /** Id-less reply while other drops are still pending — cannot be trusted. */
  | 'missing-request-id';

export type DropResolution =
  | { accepted: true; position: DropPoint | null }
  | { accepted: false; reason: DropRejection };

export interface DropRequestStore {
  /** Remember where `requestId` was dropped. False when the id is reused. */
  begin(requestId: string, position: DropPoint): boolean;
  /** Resolve a reply. `position: null` means "use the editor's default spot"
   *  (id-less reply with nothing else in flight). */
  resolve(requestId: string | undefined): DropResolution;
  pending(): number;
  clear(): void;
}

/** Matches the editor's external-drag safety timer. */
export const DROP_REQUEST_TIMEOUT_MS = 15_000;

export interface DropRequestStoreOptions {
  timeoutMs?: number;
  onTimeout?: (requestId: string) => void;
  /** Test seams, forwarded to the pending registry. */
  schedule?: (callback: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}

export function createDropRequestStore(
  options: DropRequestStoreOptions = {}
): DropRequestStore {
  const registry: PendingRequestRegistry<DropPoint> = createPendingRequestRegistry<DropPoint>(
    {
      timeoutMs: options.timeoutMs ?? DROP_REQUEST_TIMEOUT_MS,
      onTimeout: options.onTimeout,
      schedule: options.schedule,
      cancel: options.cancel,
    }
  );

  return {
    begin(requestId, position) {
      return registry.begin(requestId, position);
    },

    resolve(requestId) {
      if (requestId === undefined) {
        // Backwards compatibility: an older host echoes no id. Place the
        // thumbnail at the default spot only when no correlated drop is
        // waiting — otherwise this reply is just as likely to belong to that
        // other drop.
        if (registry.size() > 0) {
          return { accepted: false, reason: 'missing-request-id' };
        }
        return { accepted: true, position: null };
      }
      const position = registry.settle(requestId);
      if (!position) return { accepted: false, reason: 'unknown-request' };
      return { accepted: true, position };
    },

    pending() {
      return registry.size();
    },

    clear() {
      registry.clear();
    },
  };
}
