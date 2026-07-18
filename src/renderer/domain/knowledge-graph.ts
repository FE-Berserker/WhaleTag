/**
 * Pure helpers for the Knowledge Graph perspective (TagSpaces "tagsgraph").
 *
 * Builds a bipartite tag‚Üîfile graph from the current directory's tagged files
 * and computes a deterministic radial layout for it. React Flow then renders
 * the nodes/edges and handles dragging, panning and zooming.
 *
 * React/Electron-free so the graph building and layout can be unit-tested in
 * isolation (knowledge-graph.test.ts). No `Math.random` ‚Ä?layout is a pure
 * function of its input so the same graph always lays out identically.
 *
 * Previously named `mindmap.ts`; renamed in plan ¬ßH.19 to reflect that the
 * output is a bipartite tag‚Üîfile graph rather than a hierarchical mind map.
 */

import { tagCategory, type TagCategory } from './tagcloud';

export interface MindMapTagNode {
  id: string;
  kind: 'tag';
  /** Raw tag value (storage form, e.g. `5star`). */
  tag: string;
  /** Number of files carrying this tag (within the graph). */
  degree: number;
}

export interface MindMapFileNode {
  id: string;
  kind: 'file';
  name: string;
  path: string;
  /** Lowercased extension without the dot (`''` if none). */
  ext: string;
}

export interface MindMapDirectoryNode {
  id: string;
  kind: 'directory';
  name: string;
  path: string;
}

export type MindMapNode = MindMapTagNode | MindMapFileNode | MindMapDirectoryNode;

export interface MindMapEdge {
  id: string;
  /** File node id. */
  source: string;
  /** Tag node id. */
  target: string;
}

export interface MindMapGraph {
  nodes: MindMapNode[];
  edges: MindMapEdge[];
}

/** Minimal entry shape the graph builder needs (subset of DirEntry). */
export interface MindMapEntry {
  name: string;
  path: string;
  isDirectory?: boolean;
  extension?: string;
}

export interface XY {
  x: number;
  y: number;
}

const tagId = (tag: string) => `tag:${tag}`;
const fileId = (entry: MindMapEntry) => `file:${entry.path}`;
const dirId = (entry: MindMapEntry) => `dir:${entry.path}`;

function extOf(entry: MindMapEntry): string {
  if (entry.extension) return entry.extension.toLowerCase();
  const dot = entry.name.lastIndexOf('.');
  return dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Build a bipartite tag‚Üîfile graph from per-file tags.
 *
 * - Files are looked up in `tagsByName` (by `entry.path` ‚Ä?H.24 R1 made the
 *   projections path-keyed so two same-named files in different subdirs keep
 *   independent tags); directories and files with no remaining tags are
 *   omitted (no isolated nodes).
 * - `exclude` drops tags whose {@link tagCategory} is listed (e.g. hide
 *   workflow/priority/date smart tags).
 * - Each edge connects a file to one of its tags; a tag's `degree` is the
 *   number of files linked to it.
 */
export function buildGraph(
  entries: readonly MindMapEntry[],
  tagsByName: ReadonlyMap<string, readonly string[]>,
  options: { exclude?: Iterable<TagCategory> } = {}
): MindMapGraph {
  const skip = new Set(options.exclude ?? []);
  const tagNodes = new Map<string, MindMapTagNode>();
  const fileNodes: MindMapFileNode[] = [];
  const directoryNodes: MindMapDirectoryNode[] = [];
  const edges: MindMapEdge[] = [];

  for (const entry of entries) {
    const raw = tagsByName.get(entry.path);
    if (!raw || raw.length === 0) continue;

    const seen = new Set<string>();
    const tags: string[] = [];
    for (const r of raw) {
      const tag = r.trim();
      if (!tag || seen.has(tag)) continue;
      if (skip.size && skip.has(tagCategory(tag))) continue;
      seen.add(tag);
      tags.push(tag);
    }
    if (tags.length === 0) continue;

    if (entry.isDirectory) {
      const did = dirId(entry);
      directoryNodes.push({ id: did, kind: 'directory', name: entry.name, path: entry.path });
      for (const tag of tags) {
        const tid = tagId(tag);
        const existing = tagNodes.get(tid);
        if (existing) existing.degree += 1;
        else tagNodes.set(tid, { id: tid, kind: 'tag', tag, degree: 1 });
        edges.push({ id: `${did}->${tid}`, source: did, target: tid });
      }
    } else {
      const fid = fileId(entry);
      fileNodes.push({ id: fid, kind: 'file', name: entry.name, path: entry.path, ext: extOf(entry) });
      for (const tag of tags) {
        const tid = tagId(tag);
        const existing = tagNodes.get(tid);
        if (existing) existing.degree += 1;
        else tagNodes.set(tid, { id: tid, kind: 'tag', tag, degree: 1 });
        edges.push({ id: `${fid}->${tid}`, source: fid, target: tid });
      }
    }
  }

  return { nodes: [...tagNodes.values(), ...fileNodes, ...directoryNodes], edges };
}

/**
 * Halton low-discrepancy sequence. Returns a value in [0, 1) for the
 * given index `i` and prime `base`. Used to spread file nodes evenly
 * across the canvas without clustering ‚Ä?see `seedPositions`.
 */
function halton(i: number, base: number): number {
  let result = 0;
  let f = 1 / base;
  let n = i;
  while (n > 0) {
    result += f * (n % base);
    n = Math.floor(n / base);
    f /= base;
  }
  return result;
}

/** Rough rendered text width (px): CJK/full-width glyphs ‚â?font size, latin ‚â?0.58√ó. */
function textWidth(s: string, fontPx: number): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const wide = c >= 0x1100 && (c <= 0x9fff || (c >= 0xf900 && c <= 0xffef));
    w += (wide ? 1.0 : 0.58) * fontPx;
  }
  return w;
}

/**
 * Estimated rendered box (px) of a node, used for collision separation.
 * Must match the actual styles in `KnowledgeGraphView.tsx`'s `TagNode` /
 * `FileNode` components ‚Ä?if the estimate is too small, nodes will overlap
 * visually even though `resolveCollisions` thinks they're separated. Three
 * things the estimate has to get right:
 *
 *   1. **Tag pill width**: `padding: 4*scale 10*scale` + text + `boxShadow`.
 *      Capped at the view's `maxWidth: 220` (long tags ellipsize). Height
 *      includes the shadow's downward 4px bleed.
 *   2. **File chip ext span**: NOT a fixed 30px ‚Ä?it grows with the ext
 *      string. The view renders `minWidth: 22; padding: 0 4` so for ext
 *      strings longer than 3 chars (e.g. `DRAWIO`, `MARKDOWN`, `WEBP`),
 *      the chip is `textWidth(ext, 9px) + 8` which can hit 40+ px. The
 *      original 30px estimate silently failed for those formats.
 *   3. **CJK width coefficient**: real fonts render CJK at ~1.0√ó em,
 *      Latin at ~0.58√ó. The `textWidth` helper handles that ‚Ä?but we
 *      add a 12% safety margin (`* 1.12`) so font-metric drift between
 *      systems doesn't let nodes graze each other.
 *
 * All widths are then capped to mirror the view's `maxWidth` so we don't
 * chase ellipsized text.
 */
export function nodeSize(node: MindMapNode): { w: number; h: number } {
  const SAFETY = 1.12;
  if (node.kind === 'tag') {
    const scale = Math.min(1.6, 1 + Math.log10(node.degree + 1) * 0.5);
    const fontPx = 12 * scale;
    // Actual style: padding `${4*scale}px ${10*scale}px` ‚Ü?horizontal 20*scale.
    // boxShadow: `0 1px 4px rgba(0,0,0,0.3)` extends ~4px below ‚Ä?already
    // included in the height buffer.
    const w = textWidth(node.tag, fontPx) * SAFETY + 20 * scale + 4; // +4 shadow buffer
    return {
      w: Math.min(220, Math.max(44, w)),
      h: fontPx + 12 + 4, // line-height (~1.2√ó fontPx) + padding 4+4 + shadow 4
    };
  }
  if (node.kind === 'directory') {
    const fontPx = 11;
    // Directory node: padding `3px 8px` (horizontal 16) + icon (~20px)
    // + gap (6) + name text. Max width 200 like file nodes.
    const nameSpace = Math.max(20, 200 - 16 - 20 - 6);
    const w = 16 + 20 + 6 + Math.min(textWidth(node.name, fontPx) * SAFETY, nameSpace);
    return { w: Math.min(200, Math.max(64, w)), h: 22 + 4 };
  }
  const fontPx = 11;
  // Ext chip: view style is `minWidth: 22; padding: '0 4'` with fontSize: 9.
  // For long ext strings (DRAWIO, MARKDOWN, ‚Ä? the chip grows; using the
  // actual text width avoids the original estimate's silent under-count.
  const extFontPx = 9;
  const chipW = Math.max(22, textWidth(node.ext, extFontPx) * SAFETY + 8);
  // Container: padding `3px 8px 3px 4px` (horizontal 12) + chip + flex gap 6
  // + name span. Name span ellipsizes inside whatever space remains.
  const nameSpace = Math.max(20, 200 - 12 - 6 - chipW);
  const w = 12 + chipW + 6 + Math.min(textWidth(node.name, fontPx) * SAFETY, nameSpace);
  return { w: Math.min(200, Math.max(64, w)), h: 22 + 4 }; // padding 3+3 + content + shadow
}

/**
 * Push apart any pair of overlapping node boxes along their shallowest axis,
 * iterating until stable (or `iterations` is hit). Mutates `pos`. Deterministic:
 * fixed traversal order and no randomness, so the same input always settles the
 * same way. O(n¬≤¬∑iterations) ‚Ä?fine for a directory's worth of nodes.
 */
export function resolveCollisions(
  pos: Map<string, XY>,
  nodes: readonly MindMapNode[],
  options: { iterations?: number; gap?: number } = {}
): void {
  const iterations = options.iterations ?? 150;
  const gap = options.gap ?? 16;
  const size = new Map(nodes.map((n) => [n.id, nodeSize(n)]));

  for (let it = 0; it < iterations; it++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      const a = pos.get(nodes[i].id);
      const sa = size.get(nodes[i].id);
      if (!a || !sa) continue;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = pos.get(nodes[j].id);
        const sb = size.get(nodes[j].id);
        if (!b || !sb) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const ox = (sa.w + sb.w) / 2 + gap - Math.abs(dx);
        const oy = (sa.h + sb.h) / 2 + gap - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue; // not overlapping
        moved = true;
        if (ox < oy) {
          const push = (ox / 2) * (dx < 0 ? -1 : 1);
          a.x -= push;
          b.x += push;
        } else {
          const push = (oy / 2) * (dy < 0 ? -1 : 1);
          a.y -= push;
          b.y += push;
        }
      }
    }
    if (!moved) break;
  }
}

/**
 * Adaptive canvas size. The old `max(1000, ‚àöN √ó 260)` rule grew the canvas
 * geometrically with node count ‚Ä?at N=100 the canvas hit 2600px while the
 * FR ideal-edge-length (`k=90`) stayed fixed, so the force pass squeezed all
 * 100 nodes into a ~200px cluster around the center, leaving most of the
 * canvas empty. Now we tie canvas size to a target per-node spacing of ~50px
 * (so `k = span √ó 0.04` lands around 32‚Ä?6px depending on graph size), with
 * an 800px floor for tiny graphs and a 2400px cap to keep the force pass
 * cost predictable. `span` is `min(width, height)`; it's the dimension the
 * radial seed and force pass scale against.
 */
interface CanvasSize {
  width: number;
  height: number;
  span: number;
  cx: number;
  cy: number;
}

function computeCanvasSize(
  nodes: readonly MindMapNode[],
  opts: { width?: number; height?: number }
): CanvasSize {
  const n = nodes.length;
  const adaptive = Math.round(800 + Math.sqrt(Math.max(1, n)) * 50);
  const side = Math.min(2400, Math.max(800, adaptive));
  const width = opts.width ?? side;
  const height = opts.height ?? side;
  return {
    width,
    height,
    span: Math.min(width, height),
    cx: width / 2,
    cy: height / 2,
  };
}

/**
 * Radial seed phase. Tags go on an inner ring (sorted by descending degree so
 * popular tags read first); each file is pushed outward from the centroid of
 * the tags it links to, with a deterministic perpendicular jitter so files
 * sharing a tag don't stack.
 *
 * If `previousPos` is provided, nodes with an existing position keep it
 * verbatim ‚Ä?only *new* nodes are seeded. This is how the view preserves
 * layout across filter toggles / depth changes without making the graph
 * visibly jump. Existing nodes retain the exact pixel; the force pass then
 * drags any newly-seeded neighbors toward them.
 */
function seedPositions(
  graph: MindMapGraph,
  canvas: CanvasSize,
  previousPos?: Map<string, XY>
): Map<string, XY> {
  const { cx, cy, span } = canvas;
  const fileOffset = span * 0.22;
  // Tangential breathing room between adjacent tag pills on the inner ring.
  // Fixed at 50px: small enough that the inner ring fits a few dozen
  // tags on the canvas, large enough that two adjacent 44px-min pills
  // never collide (chord ‚â?88px vs required 84px). The old `tension`
  // multiplier was removed with the slider (H.19 retro).
  const tagGap = 50;

  const pos = new Map<string, XY>();

  const tags = graph.nodes
    .filter((n): n is MindMapTagNode => n.kind === 'tag')
    .sort((a, b) => b.degree - a.degree || a.tag.localeCompare(b.tag));
  const files = graph.nodes.filter(
    (n): n is MindMapFileNode | MindMapDirectoryNode =>
      n.kind === 'file' || n.kind === 'directory'
  );

  // Tag angular slots are proportional to each tag's rendered width, so wide
  // tags get more arc than narrow ones. The ring radius scales up to fit the
  // total content width + per-tag gaps (with a 12% buffer for the chord-vs-
  // arc shrinkage `2r¬∑sin(Œ∏/2) < rŒ∏`). Without this, 30 tags at span=1300
  // land at ~76px arc per neighbor while pills can be 100-220px wide, and
  // the seed itself overlaps before the collision pass even runs. Locked by
  // the `separates many tags on the inner ring` test.
  const tagWidths = tags.map((tn) => nodeSize(tn).w);
  const totalWidth = tagWidths.reduce((a, b) => a + b, 0) + tags.length * tagGap;
  const requiredRadius = tags.length > 0 ? (totalWidth * 1.12) / (2 * Math.PI) : 0;
  // Floor the ring at the smaller of `span*0.18` or a fixed 80px.
  // Earlier the floor was `span*0.28` which dominated small graphs and
  // made the `tension` slider invisible ‚Ä?raising requiredRadius
  // couldn't change tagR. The 80px minimum keeps the ring readable
  // for very few tags (so 1-2 tags aren't pinned to the center).
  const tagR = Math.max(Math.min(span * 0.18, 220), requiredRadius, 80);

  let cumulativeAngle = -Math.PI / 2; // start at top, sweep clockwise
  tags.forEach((tn, i) => {
    const prior = previousPos?.get(tn.id);
    if (prior) {
      pos.set(tn.id, prior);
      return;
    }
    const slot = totalWidth > 0 ? ((tagWidths[i] + tagGap) / totalWidth) * 2 * Math.PI : 0;
    const centerAngle = cumulativeAngle + slot / 2;
    pos.set(tn.id, {
      x: cx + tagR * Math.cos(centerAngle),
      y: cy + tagR * Math.sin(centerAngle),
    });
    cumulativeAngle += slot;
  });

  const fileTags = new Map<string, string[]>();
  for (const e of graph.edges) {
    const arr = fileTags.get(e.source);
    if (arr) arr.push(e.target);
    else fileTags.set(e.source, [e.target]);
  }

  files.forEach((fn, idx) => {
    const prior = previousPos?.get(fn.id);
    if (prior) {
      pos.set(fn.id, prior);
      return;
    }
    const tagIds = fileTags.get(fn.id) ?? [];
    let ax = 0;
    let ay = 0;
    let n2 = 0;
    for (const tid of tagIds) {
      // Tag positions may come from previousPos (existing) or from the seed
      // ring (just placed above). Either way, the file seeds relative to them.
      const p = pos.get(tid);
      if (p) {
        ax += p.x;
        ay += p.y;
        n2 += 1;
      }
    }
    if (n2 === 0) {
      pos.set(fn.id, { x: cx, y: cy });
      return;
    }
    const mx = ax / n2;
    const my = ay / n2;
    let dx = mx - cx;
    let dy = my - cy;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    // Halton 2D sequence ‚Ä?places each file at a unique, uniformly-spread
    // 2D position on the canvas. Replaces the previous tag-centroid grid
    // and sunflower distributions, both of which collapsed dense
    // clusters (6+ files sharing a tag pair) into overlapping positions
    // the collision pass couldn't fully resolve. Halton guarantees
    // every file lands at a distinct, evenly-spread position regardless
    // of how its tags connect it. Tags stay on the inner ring; files
    // form an outer halo.
    //
    // The `margin` is sized to land files just outside the tag ring
    // (with a small buffer) rather than a fraction of the canvas ‚Ä?the
    // earlier `span * 0.4` formula was overkill on large canvases and
    // crowded files into the middle on small ones. Now `margin =
    // tagR + 60px buffer`, so the Halton region scales with the actual
    // ring size and 30 files in a 1500√ó1500 canvas get the full area.
    // Deterministic (no Math.random) ‚Ä?`idx + 1` because Halton(0) is
    // degenerate.
    const tagRingRadius = Math.max(Math.min(canvas.span * 0.18, 220), 80);
    const margin = tagRingRadius + 60;
    const hx = halton(idx + 1, 2);
    const hy = halton(idx + 1, 3);
    pos.set(fn.id, {
      x: margin + hx * (canvas.width - 2 * margin),
      y: margin + hy * (canvas.height - 2 * margin),
    });
    void mx; void my; void dx; void dy; void fileOffset;
  });

  return pos;
}

/**
 * Translate every node by the same offset so the centroid sits at the canvas
 * center. Skipped when `previousPos` is in play ‚Ä?that would defeat the whole
 * point of position memory. When the seed runs cold (no previousPos) and the
 * radial layout drifts off-center (common with `width ‚â?height` or sparse
 * graph shapes), this restores the visual "node cluster in the middle of the
 * viewport" expectation. ~5 lines, fixes the "ËøõÂú∫ËäÇÁÇπ‰∏çÂú®ÂõæÂÉè‰∏≠Èó¥" complaint.
 */
function recenter(pos: Map<string, XY>, canvas: CanvasSize, skip = false): void {
  if (skip || pos.size === 0) return;
  let sumX = 0;
  let sumY = 0;
  for (const p of pos.values()) {
    sumX += p.x;
    sumY += p.y;
  }
  const dx = canvas.cx - sumX / pos.size;
  const dy = canvas.cy - sumY / pos.size;
  for (const p of pos.values()) {
    p.x += dx;
    p.y += dy;
  }
}

/**
 * Clamp every node position into the canvas with a small margin. Acts as a
 * safety net after the FR pass: high tension can fail to converge in 160
 * iterations and leave a node mid-flight far outside the canvas; once that
 * happens the user's pan/zoom never recovers it because the radial seed and
 * the recenter pass both assume positions are roughly inside the canvas.
 * ~30px margin gives the node a tiny bit of breathing room from the edge so
 * the visual cluster doesn't feel like it's glued to the viewport border.
 */
function clampToCanvas(pos: Map<string, XY>, canvas: CanvasSize): void {
  const margin = 30;
  const minX = margin;
  const maxX = canvas.width - margin;
  const minY = margin;
  const maxY = canvas.height - margin;
  for (const p of pos.values()) {
    if (p.x < minX) p.x = minX;
    else if (p.x > maxX) p.x = maxX;
    if (p.y < minY) p.y = minY;
    else if (p.y > maxY) p.y = maxY;
  }
}

/**
 * Deterministic radial layout: tags sit on an inner ring (spread by descending
 * degree), each file is pushed outward from the centroid of the tags it links
 * to, with an index-based perpendicular jitter so files sharing a tag don't
 * stack. A collision-separation pass (`collide`, on by default) then spreads
 * any remaining overlaps. Returns a map of node id ‚Ü?{x, y}. Pure: same graph ‚Ü? * same positions.
 *
 * `previousPos` (optional) preserves positions of nodes that already had a
 * layout. New nodes seed normally and the FR pass settles them relative to
 * the kept positions. When `previousPos` is supplied, the recenter pass is
 * skipped so existing nodes do not visibly drift.
 */
export function layoutGraph(
  graph: MindMapGraph,
  options: {
    width?: number;
    height?: number;
    collide?: boolean;
    physics?: boolean;
  } = {},
  previousPos?: Map<string, XY>
): Map<string, XY> {
  const collide = options.collide ?? true;
  const physics = options.physics ?? true;
  const hasMemory = previousPos !== undefined && previousPos.size > 0;
  const canvas = computeCanvasSize(graph.nodes, options);

  // 1. Seed: use previousPos for existing nodes, radial/centroid for new.
  //    No `tension` parameter anymore ‚Ä?the previous slider was removed
  //    because in dense graphs it often failed to converge within the
  //    FR iteration budget, leaving the cluster off-canvas (H.19 retro).
  //    Tag spread is now a fixed `tagGap = 50px`, wide enough for
  //    non-overlap on small graphs and scales with the tag-count-derived
  //    `requiredRadius` on large ones.
  const pos = seedPositions(graph, canvas, previousPos);

  // 2. Force pass DISABLED. The Halton seed already gives every file a
  //    unique, evenly-spread position; running FR on top of it just
  //    adds chaos. In dense graphs the cumulative file‚Üîfile repulsion
  //    pushed files to the canvas edge, then the final clamp locked them
  //    there with no way for the collision pass to recover (tested:
  //    `physics:true, collide:true` puts f1 and f7 at x=30 ‚Ä?the left
  //    margin ‚Ä?overlapping in y). `physics` is kept as an option so
  //    future callers can experiment, but it's off by default.
  // `false &&` keeps the FR pass compiled-in but unreachable (H.19 disabled
  // it because it pushed files to the canvas edge); the eslint disable is for
  // this deliberate constant condition.
  // eslint-disable-next-line no-constant-condition
  if (false && physics) {
    runForcePass(pos, graph, canvas.span * 0.04, canvas.span);
  }

  // 3. Optional collision separation. 200 + 80 iterations at gap=20 ‚Ä?  //    earlier 100 + 40 starved on dense many-to-many graphs where the
  //    Halton seed places two files close together; the iteration budget
  //    is the actual separation work now that FR is off.
  if (collide) resolveCollisions(pos, graph.nodes, { gap: 20, iterations: 200 });

  // 4. Collision pass #2: clamp pushes nodes that were settling near the
  //    edge back inside the margin, which can re-overlap with their
  //    neighbours. A short second pass cleans those up.
  if (collide) resolveCollisions(pos, graph.nodes, { gap: 20, iterations: 80 });

  // 5. Centroid recentering (skip when previousPos is in play so retained
  //    positions don't visibly drift). Recentering shifts every node by
  //    the same offset, so a previously-clamped node may end up off-canvas
  //    if the cluster was strongly off-center ‚Ä?we re-clamp *after*
  //    recenter so the final positions are guaranteed inside the canvas.
  recenter(pos, canvas, hasMemory);

  // 6. Final clamp ‚Ä?guarantees every node is inside the canvas with a
  //    30px margin regardless of where the seed, FR, collision, or
  //    recenter steps landed. Runs unconditionally (cheap, O(n)).
  clampToCanvas(pos, canvas);

  return pos;
}

/**
 * Weak file‚Üîfile repulsion pass. Mutates `pos` in place from its Halton
 * seed to push apart pairs of files that happen to land too close after
 * the 2D quasi-random seed. Skips tag‚Üîtag pairs entirely ‚Ä?those would
 * destroy the carefully-proportioned inner ring (see `separates many
 * tags on the inner ring` test). No edge attraction (was removed because
 * it collapsed dense file clusters back onto their tag centroid, and
 * `tension` is gone with it).
 *
 * Deterministic: no randomness, coincident nodes nudged apart by an
 * index-derived offset. The collision pass in `layoutGraph` does the
 * final AABB cleanup.
 */
function runForcePass(
  pos: Map<string, XY>,
  graph: MindMapGraph,
  k: number,
  span: number
): void {
  const nodes = graph.nodes;
  if (nodes.length < 2) return;
  const iterations = 60;
  let temp = span * 0.04;
  const cool = temp / (iterations + 1);
  const disp = new Map<string, XY>(nodes.map((n) => [n.id, { x: 0, y: 0 }]));

  // Identify file and directory nodes for the repulsion below ‚Ä?tags get a
  // pass so the inner ring stays put.
  const fileIds = new Set<string>();
  for (const n of graph.nodes) {
    if (n.kind === 'file' || n.kind === 'directory') fileIds.add(n.id);
  }
  // Half-strength repulsion coefficient. Lower than classic FR's `k¬≤/d`
  // because we only apply it between files (already loosely placed by
  // the Halton seed); full strength would push files past their natural
  // pairing.
  const repulseCoef = 0.4;

  for (let it = 0; it < iterations; it++) {
    for (const n of nodes) {
      const d = disp.get(n.id)!;
      d.x = 0;
      d.y = 0;
    }
    // Weak file‚Üîfile repulsion only.
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      if (!fileIds.has(a.id)) continue;
      const pa = pos.get(a.id)!;
      const da = disp.get(a.id)!;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        if (!fileIds.has(b.id)) continue;
        const pb = pos.get(b.id)!;
        let dx = pa.x - pb.x;
        let dy = pa.y - pb.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) {
          dx = ((i % 7) - 3) * 0.1 + 0.05;
          dy = ((j % 5) - 2) * 0.1 + 0.03;
          dist = Math.hypot(dx, dy) || 0.01;
        }
        const f = ((k * k) / dist) * repulseCoef;
        const ux = dx / dist;
        const uy = dy / dist;
        da.x += ux * f;
        da.y += uy * f;
        const db = disp.get(b.id)!;
        db.x -= ux * f;
        db.y -= uy * f;
      }
    }
    // Apply, capped by the cooling temperature.
    for (const n of nodes) {
      const d = disp.get(n.id)!;
      const len = Math.hypot(d.x, d.y) || 0.01;
      const step = Math.min(len, temp);
      const p = pos.get(n.id)!;
      p.x += (d.x / len) * step;
      p.y += (d.y / len) * step;
    }
    temp = Math.max(temp - cool, span * 0.001);
  }
}
