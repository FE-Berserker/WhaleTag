import { useCallback } from 'react';
import type { DirEntry } from '../../shared/ipc-types';
import { nextAvailableName } from '../../shared/dedupe-name';
import { joinPath } from '-/services/path-util';
import { useCurrentLocationContext } from '-/hooks/CurrentLocationContextProvider';
import { useDirectoryContent } from '-/hooks/DirectoryContentContextProvider';
import { useIOActionsContext } from '-/hooks/IOActionsContextProvider';
import { useExtensionContext } from '-/hooks/ExtensionContextProvider';

/**
 * Minimal valid empty Draw.io diagram, written when creating a new drawing.
 *
 * Format notes — there are TWO competing drawio contracts to satisfy at once:
 *  - drawio's `Editor.parseDiagramNode` (app.min.js) checks whether the
 *    `<diagram>` element has any non-whitespace text content. If it does, it
 *    calls `Graph.decompress` (i.e. `atob` + `pako.inflateRaw`) UNCONDITIONALLY
 *    on the text — even when the text is plain XML. The OLD placeholder was
 *    raw base64 without a `%` marker, which `atob` decoded fine but
 *    `pako.inflateRaw` couldn't decompress, raising "invalid bit length repeat".
 *    Whitespace between `<diagram>` and `<mxGraphModel>` makes the second branch
 *    win, but that branch picks the first child node — and if the first child
 *    is a text node (the whitespace), it imports it as the document root and
 *    ends up with no `documentElement`. So the only reliable form is:
 *    `<diagram>` immediately followed by `<mxGraphModel>` with NO whitespace
 *    between them. That's what we emit here, on a single line.
 *  - H.17 thumbnail pipeline (drawio-thumb.ts) reads the file as text and
 *    walks `<mxCell>` elements; both compressed (`%...`) and uncompressed
 *    (child-element) forms are handled. The uncompressed form is simpler and
 *    lets us avoid maintaining a `zlib` round-trip just for the empty file.
 */
const EMPTY_DRAWIO =
  '<mxfile version="22.1.0" type="device">' +
  '<diagram name="Page-1" id="page1">' +
  '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">' +
  '<root><mxCell id="0"/><mxCell id="1" parent="0"/></root>' +
  '</mxGraphModel>' +
  '</diagram>' +
  '</mxfile>';

/**
 * Shared "new Draw.io diagram" action: creates a deduplicated `.drawio`
 * file in the current directory and opens it in the drawio-editor extension.
 * Used by both the file-list blank-area menu and the sidebar button.
 */
export function useNewDrawio() {
  const { currentDirectoryPath, currentLocation } = useCurrentLocationContext();
  const { entries } = useDirectoryContent();
  const { createFile } = useIOActionsContext();
  const { openWithExtension, registry } = useExtensionContext();

  const available = !!registry?.extensions.some(
    (m) => m.id === 'drawio-editor'
  );
  const canCreate =
    available &&
    !!currentLocation &&
    !currentLocation.isReadOnly &&
    !!currentDirectoryPath;

  const create = useCallback(async () => {
    const manifest = registry?.extensions.find((m) => m.id === 'drawio-editor');
    if (!manifest || !currentDirectoryPath) return;
    const taken = new Set(entries.map((e) => e.name));
    const name = nextAvailableName('Diagram.drawio', taken);
    const filePath = joinPath(currentDirectoryPath, name);
    await createFile(name, EMPTY_DRAWIO);
    const entry: DirEntry = {
      name,
      path: filePath,
      isDirectory: false,
      isFile: true,
      size: EMPTY_DRAWIO.length,
      modified: new Date().toISOString(),
      extension: 'drawio',
    };
    await openWithExtension(entry, manifest);
  }, [registry, currentDirectoryPath, entries, createFile, openWithExtension]);

  return { create, available, canCreate };
}
