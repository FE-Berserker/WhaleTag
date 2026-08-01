/**
 * Relative-link rewrite for excalidraw file embeds (docs/20). A dragged-in
 * file becomes an image element whose `link` points back at the source file.
 * That link is stored RELATIVE to the .excalidraw file's directory (so a
 * folder move keeps links intact) and resolved back to an absolute bare path
 * at load time — runtime behaviour is identical to the old absolute-link
 * world, and the host's `openLinkExternally` → `openPath` is unchanged.
 *
 * Pure JSON walking — no `@excalidraw` import, no DOM — so it is testable
 * under `node:test`. drawio's analogue lives in `drop-xml.ts` (it rewrites an
 * XML attribute and converts to/from `file://` URLs); excalidraw stores a bare
 * path string on `element.link`, which is simpler.
 *
 * The excalidraw scene JSON (from `serializeAsJSON`) is
 * `{ type, version, source, elements, appState, files }`; only image / file
 * embed elements carry a `link` string, which we narrow on.
 */

import {
  dirname,
  isAbsoluteishPath,
  isExternalUrl,
  resolveRelative,
  toRelative,
} from '../shared/relpath';

type ElementRecord = Record<string, unknown>;

/** LOAD: resolve a stored relative link to an absolute bare path. External
 *  URLs and already-absolute links (old diagrams) are returned unchanged. */
function linkToAbsolute(link: string, base: string): string {
  if (isExternalUrl(link)) return link;
  if (isAbsoluteishPath(link)) return link;
  return resolveRelative(link, base);
}

/** SAVE: rewrite an absolute bare-path link to a relative `./…` path when it
 *  lives inside the diagram's directory; otherwise (external URL, already
 *  relative, or target outside the dir) return it unchanged. */
function linkToRelative(link: string, base: string): string {
  if (isExternalUrl(link)) return link;
  if (!isAbsoluteishPath(link)) return link;
  return toRelative(link, base) ?? link;
}

/** Rewrite every `element.link` in a restored scene IN PLACE (the elements
 *  come straight from `restore()`, which returns fresh unfrozen objects).
 *  Call before `updateScene`. Used on load. */
export function rewriteExcalidrawElementsToAbsolute(
  elements: unknown,
  diagramPath: string
): void {
  if (!Array.isArray(elements)) return;
  const base = dirname(diagramPath);
  for (const el of elements) {
    if (!el || typeof el !== 'object') continue;
    const e = el as ElementRecord;
    if (typeof e.link === 'string') e.link = linkToAbsolute(e.link, base);
  }
}

/** SAVE: parse an excalidraw JSON document, rewrite each absolute
 *  `element.link` inside the diagram's directory to a relative path, and
 *  re-serialize. Returns the input unchanged on a parse failure (defensive —
 *  never block a save over a link rewrite). */
export function rewriteExcalidrawJsonToRelative(
  json: string,
  diagramPath: string
): string {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return json;
  }
  const elements = (data as { elements?: unknown })?.elements;
  if (Array.isArray(elements)) {
    const base = dirname(diagramPath);
    for (const el of elements) {
      if (!el || typeof el !== 'object') continue;
      const e = el as ElementRecord;
      if (typeof e.link === 'string') e.link = linkToRelative(e.link, base);
    }
  }
  return JSON.stringify(data);
}
