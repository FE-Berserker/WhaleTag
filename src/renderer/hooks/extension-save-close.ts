/** Invoke the registered save handler for a dirty tab close.
 *
 * The host reports every failure from a handler it owns. Only a missing
 * handler has no host to report it, so the provider supplies that one generic
 * notice through this seam. Handler errors still propagate to the caller.
 */
export interface ExtensionSaveCloseGuard {
  /** Read the authoritative dirty state after the host reports success. */
  isDirty: () => boolean;
  /** Owned by the provider: the host already returned success. */
  notifyStillDirty: () => void;
}

export async function saveForExtensionClose(
  save: (() => Promise<boolean>) | undefined,
  notifyMissingHandler: () => void,
  guard?: ExtensionSaveCloseGuard
): Promise<boolean> {
  if (!save) {
    notifyMissingHandler();
    return false;
  }
  const ok = await save();
  if (!ok) return false;
  if (guard?.isDirty()) {
    // A new edit can arrive between the host's successful write and the close.
    // Keep the tab alive even though the write itself returned true.
    guard.notifyStillDirty();
    return false;
  }
  return true;
}
