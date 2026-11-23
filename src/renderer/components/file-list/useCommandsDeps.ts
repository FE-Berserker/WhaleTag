import { useStableBag } from '-/hooks/useStableBag';
import type { ListCommandsDeps } from '-/hooks/useListCommands';

/**
 * Assembles `useListCommands`' deps bag for `FileList` (P2 FileList split).
 *
 * Every field stays a reference-stable value (context callbacks, `useCallback`
 * handlers, memoized maps), so `useStableBag` hands back the previous object
 * whenever nothing real changed — which is what keeps `commands` (and through
 * it `cellData`) stable for react-window's per-row shallow compare.
 *
 * Grouped purely for readability at the call site; the flattening below is
 * field-for-field the same object the inline literal used to build.
 */
export interface UseCommandsDepsOptions {
  /** IO action bundle from `useIOActionsContext`. */
  io: Pick<
    ListCommandsDeps,
    | 'renameEntry'
    | 'moveEntry'
    | 'copyEntry'
    | 'deleteEntry'
    | 'createFolder'
    | 'createFile'
    | 'createTaggedEntry'
  >;
  /** Sidecar writers + path-keyed tag/description maps. */
  tagMeta: Pick<
    ListCommandsDeps,
    'save' | 'saveMany' | 'tagsByName' | 'descByName' | 'normalize'
  >;
  /** Selection ref/tick plumbing (P0-3). */
  selection: Pick<
    ListCommandsDeps,
    | 'selectedEntries'
    | 'setSelected'
    | 'clearSelection'
    | 'selectedPathsRef'
    | 'bumpSelection'
  >;
  /** FileList-owned UI sinks (notice + the create/package dialogs). */
  ui: Pick<
    ListCommandsDeps,
    | 'showNotice'
    | 'setPackageOpen'
    | 'setCreateKind'
    | 'setCreateWithTag'
    | 'createWithTag'
  >;
  /** Location + listing state. */
  location: Pick<
    ListCommandsDeps,
    | 'currentLocation'
    | 'currentDirectoryPath'
    | 'deleteToTrash'
    | 'refresh'
    | 'refreshTree'
  >;
  /** Optional new-entry factories. */
  factories: Pick<ListCommandsDeps, 'newExcalidraw' | 'newDrawio'>;
}

export function useCommandsDeps({
  io,
  tagMeta,
  selection,
  ui,
  location,
  factories,
}: UseCommandsDepsOptions): ListCommandsDeps {
  return useStableBag<ListCommandsDeps>({
    ...io,
    ...tagMeta,
    ...selection,
    ...ui,
    ...location,
    ...factories,
  });
}
