/**
 * Decides which extension-tab iframes stay mounted.
 *
 * Before this module every open tab rendered its own `<ExtensionHost>` and the
 * inactive ones were merely hidden with `display:none`. Switching was instant,
 * but a viewer is a whole webview: draw.io / Excalidraw are tens of MB of JS
 * heap each, and the tab strip allows up to eight, so a tab-happy session kept
 * every editor alive at once. Images and HTML documents add their own decoded
 * bitmaps on top.
 *
 * The policy keeps a bounded set mounted instead:
 *  - the active tab is always mounted;
 *  - **dirty** tabs are always mounted, even past the limit — their unsaved
 *    buffer lives inside the iframe, and the window-close flush talks to the
 *    tab's registered save handler, which only exists while the host is
 *    mounted. (An in-flight save is covered too: the dirty flag is cleared only
 *    after the write lands, so the tab stays pinned for its duration.)
 *  - the remaining slots go to the most recently used clean tabs, so the
 *    common A↔B comparison keeps both alive.
 *
 * A tab that falls out of the set is unmounted and rebuilt from its cached
 * `tab.fileContent` on the next activation. That is the same code path as an
 * external-edit reload, so the semantics are already tested; the visible cost
 * is the extension's own short boot and a scroll position reset, both
 * documented in docs/07 §4.
 */

/** How many tab iframes may live at once (including the active one). */
export const MAX_MOUNTED_TABS = 4;

export interface MountableTab {
  id: string;
  /** Monotonic activation timestamp (`ExtensionTab.lastAccessed`); newer wins. */
  lastAccessed: number;
}

/**
 * Pick the tab ids whose `ExtensionHost` should be rendered.
 *
 * `pinnedTabIds` are mounted unconditionally (dirty tabs); they may push the
 * total past `maxMounted`, and ids that are not in `tabs` are ignored so a
 * stale redux entry cannot keep a closed tab alive.
 */
export function selectMountedTabIds(
  tabs: readonly MountableTab[],
  activeTabId: string | null,
  pinnedTabIds: ReadonlySet<string>,
  maxMounted: number = MAX_MOUNTED_TABS
): Set<string> {
  const mounted = new Set<string>();
  const known = new Set<string>();
  for (const tab of tabs) known.add(tab.id);

  if (activeTabId !== null && known.has(activeTabId)) {
    mounted.add(activeTabId);
  }
  for (const id of pinnedTabIds) {
    if (known.has(id)) mounted.add(id);
  }

  const limit = Math.max(0, Math.floor(maxMounted));
  if (mounted.size >= limit) return mounted;

  // Stable sort (ties keep the tabs-array order, which is newest-first), so the
  // mount set is deterministic even when two tabs were opened in one millisecond.
  const candidates = tabs
    .filter((tab) => !mounted.has(tab.id))
    .sort((a, b) => b.lastAccessed - a.lastAccessed);
  for (const tab of candidates) {
    if (mounted.size >= limit) break;
    mounted.add(tab.id);
  }
  return mounted;
}
