/**
 * Pure XML construction for "drop a file/folder from the directory tree into
 * a drawio diagram". Extracted from `app.tsx` so the round-trip merge logic
 * (see `drawio-bridge.insertLinkedThumbnail`) can be unit-tested without
 * React/DOM.
 *
 * Drawio's embed protocol has no per-cell insertion action — the only
 * mutation surface is `action: 'load'` (replace the entire diagram). So the
 * drop path is:
 *   1. `getXml()` to fetch the current diagram (compressed format — see below)
 *   2. `decodeDrawioDiagram()` → expand the compressed payload to raw XML
 *   3. `appendSnippetToDiagram()` → append the new cell
 *   4. `loadXml()` to load the modified document (load expects RAW, not the
 *      compressed wire format — a previous step 4 that re-encoded before load
 *      made drawio choke on the base64 stream and freeze; see the note at the
 *      bottom of this file).
 *
 * Relative file links (docs/20): the diagram's on-disk `<UserObject link="…">`
 * stores a path RELATIVE to the .drawio file's directory, so a folder can be
 * moved without breaking links. `rewriteDrawioLinksToAbsolute` (load) and
 * `rewriteDrawioLinksToRelative` (save) are the two sides of that rewrite.
 * Runtime drawio always sees absolute `file://` URLs — identical to before —
 * so the host's click forwarding (`openLinkExternally` → `openPath`) is
 * unchanged.
 *
 * Why `<UserObject>` and not a bare `<mxCell link="…">`: drawio serializes
 * hyperlink cells inside a `<UserObject>` wrapper (see
 * `Graph.setAttributeForCell` in `Graph.js` — putting the link directly on
 * `<mxCell>` would clobber the cell label). This is exactly what drawio
 * does internally when a user clicks "Add link" on a cell. The relative-link
 * rewriters match by attribute (`[link]`) so they cover the `<UserObject>`
 * form our snippets produce AND any direct `<mxCell link=…>` drawio may emit.
 *
 * Why the image goes in `style="image=data:…"` and not a separate attribute:
 * drawio's image shape reads the image from the `image=` style key. The
 * drop handler at `EditorUi.importFile` line ~8027 produces this exact
 * shape on native file drops.
 */

import {
  dirname,
  fileUrlToPath,
  isExternalUrl,
  resolveRelative,
  toRelative,
} from '../shared/relpath';

/** Escape `&`, `<`, `>`, `"` in attribute values. The thumbnail data URL can
 *  contain `+`, `/`, `=` — none of those are special in XML attribute
 *  contexts, so this 4-char escape is sufficient. */
export function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Convert a base64-encoded `data:` URL into the form drawio's style parser
 *  can survive. drawio splits style on `;`, so the literal `data:image/jpeg;base64,XXX`
 *  is broken into chunks — see the H.17 freeze investigation where drawio's
 *  mxSvgCanvas2D.image tried to `GET data:image/jpeg` and emitted
 *  ERR_INVALID_URL.
 *
 *  drawio's own internal encoder (see drawio-assets/js/extensions.min.js)
 *  writes image cells as `image=data:image/jpg,<BASE64CHARS>` — note the
 *  missing `;base64,` marker. drawio strips the marker when serializing to
 *  style (to avoid the `;` separator) and re-adds it when handing the URL
 *  to an `Image` element for rendering. So the form we want is
 *  `data:<mime>,<base64chars>` with no `;base64,`. */
export function dataUrlToDrawioSafe(dataUrl: string): string {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) return dataUrl;
  const mimeType = match[1];
  const isBase64 = !!match[2];
  const payload = match[3];
  if (!isBase64) {
    return dataUrl;
  }
  // base64 alphabet (A–Z a–z 0–9 + / =) never contains `;`, so the result
  // is safe to embed in drawio's `;`-separated style attribute.
  return `data:${mimeType},${payload}`;
}

/** Convert an absolute path to a `file://` URL. `encodeURIComponent` keeps
 *  Windows drive letters (`C:\…`) and any non-ASCII characters safe. The
 *  result is a single-segment URL with no authority: `file:///C:/foo bar/baz`
 *  — `shell.openPath` (via `openNative`) accepts either the URL or the raw
 *  path, but the URL is what we want to store so the diagram is portable. */
export function toFileUrl(absolutePath: string): string {
  // Split on `/` and `\`, encode each segment, then rejoin. POSIX absolute
  // paths produce a leading empty segment from the split — strip it so the
  // URL gets the canonical 3-slash form (`file:///path`), not 4.
  const segments = absolutePath.split(/[\\/]/).map(encodeURIComponent);
  if (segments[0] === '') segments.shift();
  const joined = segments.join('/');
  // Windows: `C%3A/...` → `C:/...` after the browser decodes `%3A`. Strip the
  // escape so the URL is human-readable (`C:/...` not `C%3A/...`).
  return `file:///${joined.replace(/^(\w)%3A/, '$1:')}`;
}

/** Random unique id for the inserted cell wrapper. Drawio requires ids that
 *  don't collide with existing cells in the diagram. The caller supplies the
 *  `prefix` so unit tests can pin it. */
export function uniqueCellId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export interface FileDropSnippetOptions {
  /** Absolute path of the dragged file/folder (becomes the cell's link target
   *  — `file://` URL, encoded). */
  filePath: string;
  /** Display label for the `<UserObject label=…>` (basename is fine). */
  name: string;
  /** data: URL of the thumbnail (real one, or the generic icon fallback). */
  thumbnailDataUrl: string;
  /** Cell id — must be unique within the target diagram. */
  cellId: string;
  /** Drop position in drawio scene coordinates. */
  x: number;
  y: number;
  /** Cell size in scene units (defaults to 120×120). */
  width?: number;
  height?: number;
  /** Cell shape — `'image'` (default) renders the thumbnail as an mxImage
   *  cell; `'labeled'` renders a rounded rectangle whose label is the
   *  filename. The thumbnail is still generated by the host and passed in
   *  via `thumbnailDataUrl` so we can keep one insertion code path, but
   *  for `'labeled'` cells the icon is decorative only and the rectangle's
   *  text label is the primary visual. */
  cellKind?: 'image' | 'labeled';
}

/** Build the `<UserObject>…</UserObject>` snippet that wraps an image cell
 *  with a hyperlink. The snippet can be inserted into an existing diagram's
 *  `<root>` element to add one cell with no other side effects.
 *
 *  Position is a simple stacked layout — `app.tsx` increments `dropIndex`
 *  per drop so consecutive inserts don't overlap. (Drawio's embed protocol
 *  doesn't expose runtime viewport translation, so a precise drop-to-scene
 *  conversion isn't possible; users can drag the inserted cell afterward.) */
export function buildFileDropSnippet(options: FileDropSnippetOptions): string {
  const {
    filePath,
    name,
    thumbnailDataUrl,
    cellId,
    x,
    y,
    // Default cell size: 240×240. The original (full-resolution) image
    // bytes are embedded now (H.17), so 240 px is enough to make the
    // image clearly visible — the previous 120 px default shrank the
    // image so far down it looked like a thumbnail even when drawio
    // actually had the original. Caller can still override.
    width = 240,
    height = 240,
  } = options;
  const link = escapeXmlAttr(toFileUrl(filePath));
  const label = escapeXmlAttr(name);
  // Convert `data:image/jpeg;base64,XXX` → `data:image/jpeg,%FF...` so
  // drawio's `;`-based style parser doesn't break the image URL apart.
  const safeImage = dataUrlToDrawioSafe(thumbnailDataUrl);
  const style = escapeXmlAttr(
    `shape=image;verticalLabelPosition=bottom;labelBackgroundColor=#ffffff;verticalAlign=top;aspect=fixed;imageAspect=0;image=${safeImage};`
  );
  return (
    `<UserObject label="${label}" link="${link}" linkTarget="_blank">` +
    `<mxCell id="${escapeXmlAttr(cellId)}" ` +
    `style="${style}" ` +
    `vertex="1" parent="1">` +
    `<mxGeometry x="${x}" y="${y}" width="${width}" height="${height}" as="geometry"/>` +
    `</mxCell>` +
    `</UserObject>`
  );
}

/** Build a non-image cell snippet — a rounded rectangle whose label is the
 *  filename, hyperlinked to the source file/folder. Used for non-image
 *  drops (PDF, video, code, folders) where the user wants a labelled
 *  reference card rather than a thumbnail image. The thumbnail data URL is
 *  accepted so callers can use one insertion path, but the rendered cell
 *  intentionally does NOT include `image=…` — drawio would still display
 *  the label, but with a small icon that competes for space.
 *
 *  Defaults: 200×60 rectangle with whale-blue fill, 14pt label, link
 *  target `_blank` (routes through the host's `openLinkExternally` → for
 *  `file://` URLs the host calls `ipcApi.openNative` so the link opens in
 *  Whale's external-file handler / OS default app). */
export function buildLabeledDropSnippet(options: FileDropSnippetOptions): string {
  const {
    filePath,
    name,
    cellId,
    x,
    y,
    width = 200,
    height = 60,
  } = options;
  const link = escapeXmlAttr(toFileUrl(filePath));
  const label = escapeXmlAttr(name);
  const style = escapeXmlAttr(
    'rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;' +
      'strokeColor=#6c8ebf;fontSize=14;align=center;verticalAlign=middle;' +
      'fontStyle=1;'
  );
  return (
    `<UserObject label="${label}" link="${link}" linkTarget="_blank">` +
    `<mxCell id="${escapeXmlAttr(cellId)}" ` +
    `style="${style}" ` +
    `vertex="1" parent="1">` +
    `<mxGeometry x="${x}" y="${y}" width="${width}" height="${height}" as="geometry"/>` +
    `</mxCell>` +
    `</UserObject>`
  );
}

/** A standalone `<mxfile>` document that contains only the dropped cell.
 *  Used as a fallback when `getXml()` returns an empty/unparseable diagram
 *  (e.g. a brand-new drawio file that was never saved). */
export function buildFileDropDocument(snippet: string): string {
  const diagramId = uniqueCellId('drop');
  return (
    `<mxfile>` +
    `<diagram name="Page-1" id="${diagramId}">` +
    `<mxGraphModel>` +
    `<root>` +
    `<mxCell id="0"/>` +
    `<mxCell id="1" parent="0"/>` +
    `${snippet}` +
    `</root>` +
    `</mxGraphModel>` +
    `</diagram>` +
    `</mxfile>`
  );
}

/** Same as `buildFileDropDocument` but with the FULL set of `<mxGraphModel>`
 *  attributes that drawio's UI needs to initialize properly. The minimal
 *  version above lacks `dx`/`dy`/`grid`/`pageWidth`/`pageHeight` etc. — those
 *  default to zero in drawio's render state and the editor's toolbar /
 *  ruler can end up in a frozen state. The attributes here are mirrored
 *  from `EMPTY_DRAWIO` in `src/renderer/hooks/useNewDrawio.ts`, which is the
 *  shape the new-file action uses and which drawio has been verified to
 *  initialize cleanly. The diagram id is freshly generated per insert so
 *  consecutive drops don't collide. */
export function buildSafeSingleCellDocument(snippet: string): string {
  const diagramId = uniqueCellId('drop');
  return (
    '<mxfile version="22.1.0" type="device">' +
    `<diagram name="Page-1" id="${diagramId}">` +
    '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">' +
    '<root>' +
    '<mxCell id="0"/>' +
    '<mxCell id="1" parent="0"/>' +
    `${snippet}` +
    '</root>' +
    '</mxGraphModel>' +
    '</diagram>' +
    '</mxfile>'
  );
}

/** Pick the next drop position. Drawio cells are placed at (40, 40 + n*150)
 *  so consecutive drops stack down-right without overlapping the 120×120
 *  thumbnails (with a 30-unit gap). After the column fills we wrap to the
 *  next column at x + 150. `n` is the monotonically increasing drop index
 *  (lives in a ref in `app.tsx` so it survives across re-renders). */
export function nextDropPosition(dropIndex: number): { x: number; y: number } {
  const perColumn = 6;
  const col = Math.floor(dropIndex / perColumn);
  const row = dropIndex % perColumn;
  return { x: 40 + col * 150, y: 40 + row * 150 };
}

/**
 * Append a `<UserObject>` snippet to the `<root>` of an existing DECODED
 * drawio XML document and return the modified document. If the input has no
 * parseable `<root>` (e.g. an empty diagram), returns `null` so the caller
 * can fall back to building a fresh document from scratch.
 *
 * "Decoded" here means the `<diagram>` element has an `<mxGraphModel>`
 * element child (the uncompressed form), NOT a base64 text child. The
 * bridge calls `decodeDrawioDiagram` first, then this helper, then
 * `encodeDrawioDiagram` to feed the modified XML back to drawio.
 *
 * This is a pure DOM-manipulation helper — it runs in the renderer, where
 * `DOMParser` / `XMLSerializer` are available. Kept in this module so the
 * round-trip merge logic can be unit-tested (jsdom tests work too, but
 * `decodeDrawioDiagram` requires `fflate` which the renderer bundles).
 *
 * Drawio documents are tiny (a few KB at most) so the parser overhead is
 * negligible.
 */
export function appendSnippetToDiagram(
  decodedDiagramXml: string,
  snippet: string
): string | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(decodedDiagramXml, 'text/xml');
  // parseFromString with text/xml on malformed input yields a
  // `<parsererror>` root. Treat as unparseable.
  if (doc.getElementsByTagName('parsererror').length > 0) {
    return null;
  }
  // The current page is the first `<diagram>` element. If there is none, or
  // its `<mxGraphModel>` is missing, we can't insert — let the caller fall
  // back to a fresh document.
  const diagram = doc.querySelector('diagram');
  if (!diagram) return null;
  const model = diagram.querySelector('mxGraphModel');
  if (!model) return null;
  const root = model.querySelector('root');
  if (!root) return null;

  // Parse the snippet inside a throwaway wrapper element. Without the
  // wrapper, a top-level `<UserObject>` would itself be the documentElement
  // and we'd still extract its children, but a multi-root snippet (e.g.
  // two UserObjects side by side) would silently lose elements after the
  // first. The wrapper guarantees we walk a single container.
  //
  // We don't reuse a namespace: `<UserObject>` and `<mxCell>` are
  // unqualified in drawio's XML, and adding a namespace here would force
  // `XMLSerializer` to emit `<ns0:UserObject>` on round-trip — which
  // drawio would then fail to parse back. Keep the namespace empty.
  const snippetDoc = parser.parseFromString(
    `<wrap>${snippet}</wrap>`,
    'text/xml'
  );
  if (snippetDoc.getElementsByTagName('parsererror').length > 0) {
    return null;
  }
  const wrap = snippetDoc.querySelector('wrap');
  if (!wrap) return null;
  // Iterate over a snapshot of wrap's children, NOT `wrap.firstChild` in a
  // while loop. `doc.importNode` copies a node into `doc`'s context — it
  // does NOT remove the source from `wrap`. So `wrap.firstChild` stays
  // the same node forever and the while loop never terminates. This is
  // the actual root cause of the "drawio 卡死了" freeze the user reported
  // (H.17): decodeDrawioDiagram returns, then appendSnippetToDiagram
  // enters this infinite loop, the JS thread hangs, drawio never
  // receives the `load` action, and the orange overlay stays mounted
  // until the safety timer fires.
  const snippetNodes = Array.from(wrap.childNodes);
  for (const node of snippetNodes) {
    root.appendChild(doc.importNode(node, true));
  }

  const serializer = new XMLSerializer();
  return serializer.serializeToString(doc);
}

/**
 * Decode drawio's compressed diagram payload into raw XML the round-trip
 * logic can edit. See `Graph.compress` in drawio's `Graph.js`:
 *
 *   pako.deflateRaw(encodeURIComponent(innerXml)) → btoa(...) → text child
 *   of `<diagram>`
 *
 * We reverse it: `atob` → `pako.inflateRaw` (fflate's `decompressSync`
 * auto-detects raw deflate) → `decodeURIComponent`. Then we re-attach the
 * decoded `<mxGraphModel>` as an element child of the `<diagram>` so the
 * resulting XML is structurally identical to a hand-authored drawio file.
 *
 * Returns `null` if the input doesn't look like a drawio `<mxfile>` or the
 * compressed payload fails to decode (the caller falls back to building a
 * fresh document).
 *
 * If the payload is already uncompressed (has `<mxGraphModel>` as a child
 * element), it's returned as-is — so this is safe to call on hand-authored
 * diagrams too.
 */
export function decodeDrawioDiagram(payload: string): string | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(payload, 'text/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return null;
  const diagram = doc.querySelector('diagram');
  if (!diagram) return null;
  // Already uncompressed — nothing to do.
  if (diagram.querySelector('mxGraphModel')) return payload;

  // Compressed form: the diagram's text content is base64(deflateRaw(URI-enc)).
  const text = (diagram.textContent ?? '').trim();
  if (!text) return null;
  try {
    const binStr = atob(text);
    const bytes = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i += 1) bytes[i] = binStr.charCodeAt(i);
    // fflate's `decompressSync` auto-detects zlib vs raw deflate vs gzip —
    // matches `pako.inflateRaw` for drawio's default format.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fflate = require('fflate');
    const inflated = fflate.decompressSync(bytes);
    const innerXml = decodeURIComponent(new TextDecoder().decode(inflated));
    // Build a fresh <diagram> with the decoded inner XML as its child, then
    // splice it back into the outer document so we preserve the `<mxfile>`
    // attributes (host, modified, agent, version, etag, ...).
    const innerDoc = parser.parseFromString(
      `<wrap>${innerXml}</wrap>`,
      'text/xml'
    );
    const wrap = innerDoc.querySelector('wrap');
    if (!wrap) return null;
    while (diagram.firstChild) diagram.removeChild(diagram.firstChild);
    // Snapshot wrap's children before iterating. `doc.importNode` COPIES
    // a node — it does NOT remove it from wrap — so iterating with
    // `while (wrap.firstChild)` would loop forever (same bug as
    // appendSnippetToDiagram, see H.17 freeze investigation).
    const innerNodes = Array.from(wrap.childNodes);
    for (const node of innerNodes) {
      diagram.appendChild(doc.importNode(node, true));
    }
    return new XMLSerializer().serializeToString(doc);
  } catch {
    return null;
  }
}

// Note: there's NO symmetric `encodeDrawioDiagram` helper. drawio's `load`
// action always expects raw uncompressed XML (it parses the string directly
// with `mxUtils.parseXml`), and `getXml()`/autosave/`export` emit the
// COMPRESSED wire format. The round-trip is decode → edit → loadXml(raw);
// re-encoding before load is what froze drawio (the H.17 bug).
//
// Relative links (docs/20) lean on the same asymmetry: on SAVE we decode
// getXml()'s compressed output, rewrite the links, and store the RAW decoded
// document — no re-compression needed, because the on-disk format is consumed
// only by our own `decodeDrawioDiagram` on the next load (drawio never reads
// the file directly; it receives whatever we pass to loadXml). Storing raw is
// also more compatible with the external drawio app, which reads uncompressed
// `.drawio` natively.

/**
 * Walk every element carrying a `link` attribute in a DECODED drawio document
 * and rewrite each link via `fn`. drawio stores the hyperlink on `<UserObject>`
 * (our drop snippets) but may also serialize it directly on `<mxCell>`, so we
 * match by attribute, not tag name. Returns the serialized document, or `null`
 * if the input is unparseable (the caller falls back to the original string).
 *
 * Uses the same DOMParser / XMLSerializer pair as `appendSnippetToDiagram`, so
 * it inherits the same no-namespace-pollution guarantee (no `ns0:` prefixes on
 * round-trip). Run in the renderer — DOMParser/XMLSerializer are available.
 */
function mapDrawioLinks(
  decodedXml: string,
  fn: (link: string) => string
): string | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(decodedXml, 'text/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return null;
  const nodes = doc.querySelectorAll('[link]');
  nodes.forEach((node) => {
    const current = node.getAttribute('link');
    if (current == null) return;
    const next = fn(current);
    if (next !== current) node.setAttribute('link', next);
  });
  return new XMLSerializer().serializeToString(doc);
}

/**
 * LOAD side of the relative-link rewrite (docs/20 §4/§5). Stored links are
 * relative to the .drawio file's directory; rewrite them back to absolute
 * `file://` URLs so drawio's runtime sees exactly what it saw before relative
 * storage existed (the host's click handler is unchanged). External URLs
 * (http/mailto/…) and already-absolute `file://` links (old diagrams that were
 * never re-saved) are left untouched. `diagramPath` is the .drawio file path.
 *
 * Feed this the DECODED diagram (run `decodeDrawioDiagram` first — old files
 * are compressed; only new saves are raw).
 */
export function rewriteDrawioLinksToAbsolute(
  decodedXml: string,
  diagramPath: string
): string {
  const base = dirname(diagramPath);
  const out = mapDrawioLinks(decodedXml, (link) => {
    if (isExternalUrl(link)) return link;
    if (/^file:/i.test(link)) return link; // already absolute (old diagram)
    return toFileUrl(resolveRelative(link, base));
  });
  return out ?? decodedXml;
}

/**
 * SAVE side of the relative-link rewrite (docs/20 §4/§5). Rewrite absolute
 * `file://` links whose target lives INSIDE the .drawio file's directory to
 * relative `./…` paths, so the diagram survives a folder move/copy/share.
 * Targets outside the directory, external URLs, and already-relative links are
 * left as-is. `diagramPath` is the .drawio file path. Returns the (still raw)
 * document; the caller stores it without re-compression — see the note above.
 */
export function rewriteDrawioLinksToRelative(
  decodedXml: string,
  diagramPath: string
): string {
  const base = dirname(diagramPath);
  const out = mapDrawioLinks(decodedXml, (link) => {
    if (isExternalUrl(link)) return link;
    if (!/^file:/i.test(link)) return link; // not our file URL → leave
    const rel = toRelative(fileUrlToPath(link), base);
    return rel ?? link; // null → outside dir → keep absolute
  });
  return out ?? decodedXml;
}