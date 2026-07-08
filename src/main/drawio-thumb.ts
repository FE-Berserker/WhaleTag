import { promises as fsp } from 'fs';
import zlib from 'zlib';
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';

/**
 * Renders a drawio (diagrams.net) `.drawio` / `.dio` file to a PNG buffer for
 * thumbnailing. The first `<diagram>` in the mxfile is decoded (handles
 * deflate+base64 compressed diagrams), parsed into mxCells, and drawn onto a
 * `@napi-rs/canvas` with the same "preview-level" fidelity as
 * `excalidraw-thumb.ts`: recognized shape styles get a recognizable render;
 * unknown shapes / custom stencils fall back to a labelled rectangle; edges
 * are straight lines with optional arrow heads (no orthogonal routing). Throws
 * on parse failure so `thumbnail.ts` can fall back to a file-type icon.
 *
 * Why pure JS instead of mxgraph: mxgraph is browser-only and pulls in the
 * full drawio-assets (~100MB). The main-process thumbnail path is hot for
 * every visible cell, so we want it dependency-free, fast, and side-effect
 * free (no spawn, no headless Electron). See plan §H.17.
 */

/** High-res render edge; the thumbnail pipeline downsizes to 256px afterwards. */
const RENDER_MAX = 1024;
const PAD = 16;
/** Cap cells rendered so a huge diagram can't stall the main process. */
const MAX_CELLS = 5000;

// --- drawio default colors (mirrors mxgraph defaults) ---------------------
const DEFAULT_STROKE = '#1e1e1e';
const DEFAULT_FILL = '#ffffff';
const DEFAULT_FONT = 'Helvetica, Arial, sans-serif';
const SWIMLANE_TITLE_BG = '#dae8fc'; // mxgraph default swimlane fill
const SWIMLANE_BODY_BG = '#ffffff';

// --- types ----------------------------------------------------------------

interface Geometry {
  x: number;
  y: number;
  w: number;
  h: number;
  /** When `relative=1`, `x` / `y` are offsets from the source / target cell. */
  relative: boolean;
}

interface ParsedCell {
  id: string;
  parent: string;
  source?: string;
  target?: string;
  value: string;
  style: Record<string, string>;
  /** `vertex=1` / `edge=1`; absent => default (vertex) or group (parent of others). */
  isEdge: boolean;
  isVertex: boolean;
  geom: Geometry;
  /** True when `<mxGeometry>` had explicit `width` / `height` (vertex with visible size). */
  hasSize: boolean;
}

interface DiagramModel {
  cells: Map<string, ParsedCell>;
  /** Bounding box of all visible cells in model coordinates. */
  bbox: { x: number; y: number; w: number; h: number } | null;
  /** Optional page-level background (e.g. `mxGraphModel.background`). */
  background: string | null;
}

// --- mxfile / mxGraphModel XML parsing -----------------------------------

/** Reads the file and returns the first diagram's mxGraphModel XML body. */
function readFirstDiagramXml(xmlText: string): string | null {
  // Find the first <diagram ...>...</diagram> block.
  const diagramStart = xmlText.search(/<diagram\b[^>]*>/i);
  if (diagramStart < 0) return null;
  const bodyStart = xmlText.indexOf('>', diagramStart) + 1;
  const bodyEnd = xmlText.toLowerCase().indexOf('</diagram>', bodyStart);
  if (bodyEnd < 0) return null;
  let body = xmlText.slice(bodyStart, bodyEnd);
  // Compressed diagrams store the inner XML as deflate+base64 with a
  // conventional leading `%` marker. We only treat the body as compressed
  // when that marker is present — otherwise plain XML (with or without
  // leading whitespace) passes through unchanged. Trying to inflate
  // unmarked base64 (e.g. an unrecognised payload) throws
  // "invalid bit length repeat" from zlib, so we don't guess.
  if (body.trim().startsWith('%')) {
    body = inflateDiagramBody(body);
  }
  return body;
}

/**
 * Inflates a drawio compressed diagram body. The encoding is raw deflate
 * (no zlib header) over either standard or URL-safe base64, so we map the
 * URL-safe alphabet back to standard before decoding.
 */
function inflateDiagramBody(body: string): string {
  const stripped = body.replace(/^%+/, '').replace(/\s+/g, '');
  const std = stripped.replace(/-/g, '+').replace(/_/g, '/');
  const raw = Buffer.from(std, 'base64');
  // The new @types/node split Buffer out of the Uint8Array InputType union, so
  // pass the underlying ArrayBuffer view explicitly.
  const inflated = zlib.inflateRawSync(
    new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  );
  return inflated.toString('utf8');
}

/** Pulls a single attribute value out of an opening tag's text. */
function pickAttr(tagText: string, name: string): string | null {
  // Matches `name="value"` or `name='value'`; values may contain anything
  // except the matching quote. drawio files use double quotes throughout.
  const re = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i');
  const m = re.exec(tagText);
  return m ? m[1] : null;
}

/** Splits a drawio style string (`k1=v1;k2=v2;flag`) into a lookup map. */
function parseStyle(style: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!style) return out;
  for (const pair of style.split(';')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq < 0) {
      out[pair.trim().toLowerCase()] = '';
    } else {
      out[pair.slice(0, eq).trim().toLowerCase()] = pair.slice(eq + 1).trim();
    }
  }
  return out;
}

/** Parses the children of an `<mxGeometry>` element. */
function parseGeometry(geomXml: string | null): Geometry {
  const fallback: Geometry = { x: 0, y: 0, w: 0, h: 0, relative: false };
  if (!geomXml) return fallback;
  // We only need the opening tag of mxGeometry; pull attributes.
  const m = /<mxGeometry\b([^>]*)\/?>/i.exec(geomXml);
  if (!m) return fallback;
  const attrs = m[1];
  const rel = pickAttr(attrs, 'relative') === '1';
  // drawio also accepts `as="geometry"` children like <mxPoint>; we don't
  // need them for the MVP (we treat source/target anchors as cell centers).
  return {
    x: Number(pickAttr(attrs, 'x') ?? 0) || 0,
    y: Number(pickAttr(attrs, 'y') ?? 0) || 0,
    w: Number(pickAttr(attrs, 'width') ?? 0) || 0,
    h: Number(pickAttr(attrs, 'height') ?? 0) || 0,
    relative: rel,
  };
}

function parseDiagram(xml: string): DiagramModel | null {
  // Find mxGraphModel block (its inner XML is what we walk).
  const modelMatch = /<mxGraphModel\b([^>]*)>([\s\S]*?)<\/mxGraphModel>/i.exec(xml);
  if (!modelMatch) return null;
  const modelAttrs = modelMatch[1];
  const modelBody = modelMatch[2];
  const background = pickAttr(modelAttrs, 'background');

  // Walk every mxCell (self-closing or with a child mxGeometry).
  const cellRe = /<mxCell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mxCell>)/gi;
  const cells = new Map<string, ParsedCell>();
  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = cellRe.exec(modelBody)) !== null) {
    if (count >= MAX_CELLS * 4) break; // hard cap while parsing too
    count += 1;
    const attrs = match[1] ?? '';
    const inner = match[2] ?? '';
    const id = pickAttr(attrs, 'id') ?? '';
    if (!id) continue;
    const parent = pickAttr(attrs, 'parent') ?? '';
    const source = pickAttr(attrs, 'source');
    const target = pickAttr(attrs, 'target');
    const value = pickAttr(attrs, 'value') ?? '';
    const style = parseStyle(pickAttr(attrs, 'style'));
    const isEdge = pickAttr(attrs, 'edge') === '1';
    const isVertex = pickAttr(attrs, 'vertex') === '1';
    const geom = parseGeometry(inner);
    // Geometry has explicit size when its opening tag carried `width` or
    // `height` attributes (drawio puts these on `<mxGeometry>`, not `<mxCell>`).
    const hasSize = /\bwidth\s*=/.test(inner) || /\bheight\s*=/.test(inner);
    cells.set(id, {
      id,
      parent,
      source: source ?? undefined,
      target: target ?? undefined,
      value: decodeHtmlEntities(value),
      style,
      isEdge,
      isVertex,
      geom,
      hasSize,
    });
  }

  if (cells.size === 0) return null;

  // Compute bounding box over vertex cells with explicit size.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of cells.values()) {
    if (c.isEdge) continue;
    if (!c.hasSize) continue;
    minX = Math.min(minX, c.geom.x);
    minY = Math.min(minY, c.geom.y);
    maxX = Math.max(maxX, c.geom.x + c.geom.w);
    maxY = Math.max(maxY, c.geom.y + c.geom.h);
  }
  const bbox =
    Number.isFinite(minX) && maxX - minX > 0 && maxY - minY > 0
      ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
      : null;

  return { cells, bbox, background: background || null };
}

/** Decodes the small subset of HTML entities that drawio uses in `value=`. */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, '\n')
    .replace(/&#13;/g, '\r');
}

// --- shape / style helpers ------------------------------------------------

function styleColor(style: Record<string, string>, key: string, fallback: string): string {
  const raw = style[key];
  if (!raw) return fallback;
  const v = raw.toLowerCase();
  if (v === 'none' || v === 'default') return fallback;
  return raw;
}

function styleNumber(style: Record<string, string>, key: string, fallback: number): number {
  const raw = style[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function styleBool(style: Record<string, string>, key: string): boolean {
  const raw = style[key];
  return raw === '1' || raw === 'true';
}

/** Visible top-left / bottom-right of a cell's bbox in model coordinates. */
function cellRect(c: ParsedCell): { x: number; y: number; w: number; h: number } {
  return { x: c.geom.x, y: c.geom.y, w: c.geom.w, h: c.geom.h };
}

function cellCenter(c: ParsedCell): { x: number; y: number } {
  return { x: c.geom.x + c.geom.w / 2, y: c.geom.y + c.geom.h / 2 };
}

// --- drawing --------------------------------------------------------------

/** Splits text into lines, respecting `\n`. Long lines wrap onto two. */
function layoutText(value: string, html: boolean): string[] {
  if (!value) return [];
  if (!html) return [value];
  return value.split(/\r?\n/);
}

/** Draws `lines` into the cell rect, honoring `align` / `verticalAlign`. */
function drawCellText(
  ctx: SKRSContext2D,
  lines: string[],
  rect: { x: number; y: number; w: number; h: number },
  style: Record<string, string>,
  fontSize: number
): void {
  if (lines.length === 0) return;
  const padding = 4;
  const align = (style.align || 'center').toLowerCase();
  const valign = (style.valign || 'middle').toLowerCase();
  const lineHeight = fontSize * 1.25;
  const totalH = lineHeight * lines.length;
  const innerW = Math.max(1, rect.w - padding * 2);
  const innerH = Math.max(1, rect.h - padding * 2);

  ctx.fillStyle = styleColor(style, 'fontcolor', '#1e1e1e');
  ctx.textBaseline = 'top';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Truncate visually with an ellipsis when overflowing horizontally.
    let display = line;
    if (ctx.measureText(line).width > innerW) {
      let lo = 0;
      let hi = line.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (ctx.measureText(line.slice(0, mid) + '…').width <= innerW) lo = mid;
        else hi = mid - 1;
      }
      display = line.slice(0, lo) + '…';
    }
    const tw = ctx.measureText(display).width;
    let tx: number;
    if (align === 'left') tx = rect.x + padding;
    else if (align === 'right') tx = rect.x + rect.w - padding - tw;
    else tx = rect.x + (rect.w - tw) / 2;

    let ty: number;
    if (valign === 'top') ty = rect.y + padding;
    else if (valign === 'bottom') ty = rect.y + rect.h - padding - totalH + i * lineHeight;
    else ty = rect.y + (rect.h - totalH) / 2 + i * lineHeight;
    // Clamp into the rect so labels don't leak out of tiny cells.
    ty = Math.max(rect.y + 1, Math.min(ty, rect.y + rect.h - lineHeight - 1));
    ctx.fillText(display, tx, ty);
  }
  void innerH;
}

function setLineStyle(ctx: SKRSContext2D, style: Record<string, string>): void {
  ctx.lineWidth = Math.max(1, styleNumber(style, 'strokewidth', 1));
  if (styleBool(style, 'dashed')) ctx.setLineDash([6, 4]);
  else if (styleBool(style, 'dotted')) ctx.setLineDash([1, 3]);
  else ctx.setLineDash([]);
}

function setFont(
  ctx: SKRSContext2D,
  style: Record<string, string>
): { fontSize: number; html: boolean } {
  const fontSize = styleNumber(style, 'fontsize', 12);
  const styleFlag = styleNumber(style, 'fontstyle', 0);
  const weight = styleFlag & 1 ? 'bold' : 'normal';
  const italic = styleFlag & 2 ? 'italic' : 'normal';
  const family = style.fontfamily || DEFAULT_FONT;
  ctx.font = `${italic} ${weight} ${fontSize}px ${family}`;
  return { fontSize, html: style.html !== '0' };
}

function pathRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  ctx.beginPath();
  ctx.rect(x, y, w, h);
}

function pathRounded(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function pathEllipse(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  ctx.beginPath();
  ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
}

function pathDiamond(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + w / 2, y);
  ctx.lineTo(x + w, y + h / 2);
  ctx.lineTo(x + w / 2, y + h);
  ctx.lineTo(x, y + h / 2);
  ctx.closePath();
}

function pathParallelogram(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const off = Math.max(8, Math.min(w, h) * 0.2);
  ctx.beginPath();
  ctx.moveTo(x + off, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w - off, y + h);
  ctx.lineTo(x, y + h);
  ctx.closePath();
}

function pathHexagon(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const off = Math.max(8, Math.min(w, h) * 0.2);
  ctx.beginPath();
  ctx.moveTo(x + off, y);
  ctx.lineTo(x + w - off, y);
  ctx.lineTo(x + w, y + h / 2);
  ctx.lineTo(x + w - off, y + h);
  ctx.lineTo(x + off, y + h);
  ctx.lineTo(x, y + h / 2);
  ctx.closePath();
}

function pathCylinder(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const rx = w / 2;
  const ry = Math.max(4, Math.min(h * 0.15, 16));
  ctx.beginPath();
  ctx.moveTo(x, y + ry);
  // left side
  ctx.lineTo(x, y + h - ry);
  // bottom ellipse arc
  ctx.ellipse(x, y + h - ry, rx, ry, 0, Math.PI, 0, false);
  // right side back up
  ctx.lineTo(x + w, y + ry);
  // top ellipse arc
  ctx.ellipse(x, y + ry, rx, ry, 0, 0, Math.PI * 2, false);
  ctx.closePath();
}

function pathCloud(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  // Rough cloud: 4 humps along the top + a flatter bottom.
  ctx.beginPath();
  const cy = y + h / 2;
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + h * 0.6);
  ctx.ellipse(x, cy, w * 0.2, h * 0.3, 0, Math.PI, 0);
  ctx.ellipse(x + w * 0.25, y + h * 0.3, w * 0.25, h * 0.3, 0, Math.PI, 0);
  ctx.ellipse(x + w * 0.55, y + h * 0.25, w * 0.25, h * 0.35, 0, Math.PI, 0);
  ctx.ellipse(x + w * 0.85, y + h * 0.35, w * 0.2, h * 0.3, 0, Math.PI, 0);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
}

function pathSwimlane(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number
): { body: { x: number; y: number; w: number; h: number }; title: string } {
  const titleH = Math.max(18, h * 0.18);
  // Outer rounded rect is drawn by the caller; we just emit a clip suggestion.
  return {
    body: { x, y: y + titleH, w, h: h - titleH },
    title: '', // title is the first line of the cell's value
  };
}

function drawArrowHead(
  ctx: SKRSContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  kind: string,
  size: number
): void {
  if (!kind || kind === 'none') return;
  const ang = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.save();
  ctx.translate(to.x, to.y);
  ctx.rotate(ang);
  if (kind === 'classic' || kind === 'classicThin' || kind === 'block') {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-size, size / 2);
    ctx.lineTo(-size, -size / 2);
    ctx.closePath();
    ctx.fill();
  } else if (kind === 'open' || kind === 'openThin') {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-size, size / 2);
    ctx.moveTo(0, 0);
    ctx.lineTo(-size, -size / 2);
    ctx.stroke();
  } else if (kind === 'diamond') {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-size, size / 2);
    ctx.lineTo(-size * 1.6, 0);
    ctx.lineTo(-size, -size / 2);
    ctx.closePath();
    ctx.fill();
  } else {
    // Unknown arrow name: best-effort filled triangle.
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-size, size / 2);
    ctx.lineTo(-size, -size / 2);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function drawVertex(ctx: SKRSContext2D, c: ParsedCell, model: DiagramModel): void {
  if (!c.hasSize || c.geom.w <= 0 || c.geom.h <= 0) return;
  const style = c.style;
  const stroke = styleColor(style, 'strokecolor', DEFAULT_STROKE);
  const fill = styleColor(style, 'fillcolor', DEFAULT_FILL);
  const opacity = Math.max(0, Math.min(1, styleNumber(style, 'opacity', 100) / 100));

  ctx.save();
  ctx.globalAlpha = opacity;
  setLineStyle(ctx, style);
  ctx.strokeStyle = stroke;
  ctx.fillStyle = fill;

  const r = cellRect(c);
  const isText = style.shape === 'text' || c.isVertex === false;
  const shape = style.shape;
  const rounded = styleBool(style, 'rounded') || style.roundedcorner != null;
  const cornerR = Math.max(
    0,
    Math.min(
      Number(style.roundedcorner ?? 0) || 6,
      Math.min(r.w, r.h) * 0.5
    )
  );

  if (isText) {
    // No border, no fill — just text later.
  } else if (style.ellipse != null || shape === 'ellipse') {
    pathEllipse(ctx, r.x, r.y, r.w, r.h);
    ctx.fill();
    ctx.stroke();
  } else if (shape === 'rhombus') {
    pathDiamond(ctx, r.x, r.y, r.w, r.h);
    ctx.fill();
    ctx.stroke();
  } else if (shape === 'parallelogram') {
    pathParallelogram(ctx, r.x, r.y, r.w, r.h);
    ctx.fill();
    ctx.stroke();
  } else if (shape === 'hexagon') {
    pathHexagon(ctx, r.x, r.y, r.w, r.h);
    ctx.fill();
    ctx.stroke();
  } else if (shape === 'cylinder3' || shape === 'cylinder') {
    pathCylinder(ctx, r.x, r.y, r.w, r.h);
    ctx.fill();
    ctx.stroke();
  } else if (shape === 'cloud') {
    pathCloud(ctx, r.x, r.y, r.w, r.h);
    ctx.fill();
    ctx.stroke();
  } else if (shape === 'image') {
    // Embedded image: gray placeholder + label, mirrors excalidraw-thumb.
    ctx.fillStyle = '#d7dae2';
    pathRect(ctx, r.x, r.y, r.w, r.h);
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.stroke();
  } else {
    if (rounded) {
      pathRounded(ctx, r.x, r.y, r.w, r.h, cornerR || Math.min(r.w, r.h) * 0.1);
    } else {
      pathRect(ctx, r.x, r.y, r.w, r.h);
    }
    // Swimlanes: split into a darker title strip + lighter body.
    if (style.swimlane != null) {
      const { body, title } = pathSwimlane(ctx, r.x, r.y, r.w, r.h);
      void body;
      ctx.fill();
      ctx.stroke();
      // Title strip overlay.
      ctx.save();
      ctx.fillStyle = styleColor(style, 'swimlanefillcolor', SWIMLANE_TITLE_BG);
      const titleH = Math.max(18, r.h * 0.18);
      pathRounded(ctx, r.x, r.y, r.w, titleH, cornerR || Math.min(r.w, titleH) * 0.1);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      void title;
    } else {
      ctx.fill();
      ctx.stroke();
    }
  }

  // Text — drawn for every cell with a value, including `shape=text`.
  if (c.value) {
    const font = setFont(ctx, style);
    const lines = layoutText(c.value, font.html);
    drawCellText(ctx, lines, r, style, font.fontSize);
  }
  ctx.restore();
  void model; // reserved for future group-aware rendering
}

function drawEdge(
  ctx: SKRSContext2D,
  c: ParsedCell,
  model: DiagramModel
): void {
  if (!c.source || !c.target) return;
  const src = model.cells.get(c.source);
  const tgt = model.cells.get(c.target);
  if (!src || !tgt) return;
  const style = c.style;
  const stroke = styleColor(style, 'strokecolor', DEFAULT_STROKE);
  const opacity = Math.max(0, Math.min(1, styleNumber(style, 'opacity', 100) / 100));

  // Source / target anchors. For MVP, treat each as the cell's center; the
  // cell's own `<mxGeometry>` (when relative=1) is treated as an offset from
  // the source / target center.
  const sc = cellCenter(src);
  const tc = cellCenter(tgt);
  const sx = sc.x + (c.geom.relative ? c.geom.x : 0);
  const sy = sc.y + (c.geom.relative ? c.geom.y : 0);
  const tx = tc.x + (c.geom.relative ? c.geom.x : 0);
  const ty = tc.y + (c.geom.relative ? c.geom.y : 0);

  ctx.save();
  ctx.globalAlpha = opacity;
  setLineStyle(ctx, style);
  ctx.strokeStyle = stroke;
  ctx.fillStyle = stroke;
  ctx.lineWidth = Math.max(1, styleNumber(style, 'strokewidth', 1));
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(tx, ty);
  ctx.stroke();

  const arrowSize = Math.max(6, ctx.lineWidth * 4);
  drawArrowHead(
    ctx,
    { x: sx, y: sy },
    { x: tx, y: ty },
    (style.endarrow || 'none').toLowerCase(),
    arrowSize
  );
  drawArrowHead(
    ctx,
    { x: tx, y: ty },
    { x: sx, y: sy },
    (style.startarrow || 'none').toLowerCase(),
    arrowSize
  );

  if (c.value) {
    const font = setFont(ctx, style);
    const lines = layoutText(c.value, font.html);
    const mx = (sx + tx) / 2;
    const my = (sy + ty) / 2;
    const rect = { x: mx - 60, y: my - font.fontSize, w: 120, h: font.fontSize * 2 };
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.restore();
    drawCellText(ctx, lines, rect, style, font.fontSize);
  }
  ctx.restore();
}

// --- entry point ----------------------------------------------------------

export async function renderDrawioToPng(srcPath: string): Promise<Buffer> {
  const text = await fsp.readFile(srcPath, 'utf8');
  const diagramXml = readFirstDiagramXml(text);
  if (!diagramXml) throw new Error('drawio: no <diagram> in mxfile');
  const model = parseDiagram(diagramXml);
  if (!model) throw new Error('drawio: no <mxGraphModel> in diagram');

  // Bounding box: explicit vertex bbox; fallback to a small empty canvas.
  let minX = 0;
  let minY = 0;
  let bw = 200;
  let bh = 150;
  if (model.bbox) {
    minX = model.bbox.x;
    minY = model.bbox.y;
    bw = model.bbox.w;
    bh = model.bbox.h;
  }

  // Scale to fit RENDER_MAX on the longer edge. Strokes are scaled too.
  const scale = Math.min(RENDER_MAX / Math.max(1, bw), RENDER_MAX / Math.max(1, bh), 4);
  const cw = Math.max(1, Math.round(bw * scale) + PAD * 2);
  const ch = Math.max(1, Math.round(bh * scale) + PAD * 2);

  const canvas = createCanvas(cw, ch);
  const ctx = canvas.getContext('2d');

  // Background — explicit (rare) or white. The mxgraph default page color is
  // white; the `background` attribute is a fill applied beneath everything.
  ctx.fillStyle = model.background || SWIMLANE_BODY_BG;
  ctx.fillRect(0, 0, cw, ch);

  ctx.setTransform(scale, 0, 0, scale, PAD - minX * scale, PAD - minY * scale);

  // Render edges first, then vertices, so cells sit on top of their connectors.
  // Iterate in model order; we cap at MAX_CELLS to keep main-process latency low.
  const all = Array.from(model.cells.values()).slice(0, MAX_CELLS);
  for (const c of all) {
    if (c.isEdge) drawEdge(ctx, c, model);
  }
  for (const c of all) {
    if (!c.isEdge) drawVertex(ctx, c, model);
  }

  return canvas.encode('png');
}
