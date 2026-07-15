import { promises as fsp } from 'fs';
import type { SKRSContext2D } from '@napi-rs/canvas';
import { getCanvas } from './lazy-native';

/**
 * Renders an `.excalidraw` scene to a PNG for thumbnailing. Excalidraw's own
 * exporter needs a browser/DOM, so this is a lightweight main-process renderer:
 * it parses the scene JSON and draws the common element types onto a
 * `@napi-rs/canvas` with plain (non-hand-drawn) strokes — enough for a
 * recognizable preview. Unknown element types are skipped.
 */

/** High-res render edge; the thumbnail pipeline downsizes to 256px afterwards. */
const RENDER_MAX = 512;
const PAD = 12;
/** Cap elements rendered so a huge scene can't stall the main process. */
const MAX_ELEMENTS = 5000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type El = any;

function strokeFor(e: El): string {
  return typeof e.strokeColor === 'string' ? e.strokeColor : '#1e1e1e';
}
function fillFor(e: El): string | null {
  const bg = e.backgroundColor;
  return typeof bg === 'string' && bg !== 'transparent' ? bg : null;
}

function drawElement(ctx: SKRSContext2D, e: El): void {
  const x = e.x || 0;
  const y = e.y || 0;
  const w = e.width || 0;
  const h = e.height || 0;
  ctx.save();
  ctx.globalAlpha = typeof e.opacity === 'number' ? e.opacity / 100 : 1;
  ctx.lineWidth = e.strokeWidth || 1.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = strokeFor(e);
  const fill = fillFor(e);

  // Excalidraw rotates around the element's center.
  if (e.angle) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    ctx.translate(cx, cy);
    ctx.rotate(e.angle);
    ctx.translate(-cx, -cy);
  }

  switch (e.type) {
    case 'rectangle':
    case 'frame':
    case 'embeddable':
    case 'image': {
      if (e.type === 'image') {
        // We don't have the embedded image bytes here; show a placeholder box.
        ctx.fillStyle = '#d7dae2';
        ctx.fillRect(x, y, w, h);
      } else if (fill) {
        ctx.fillStyle = fill;
        ctx.fillRect(x, y, w, h);
      }
      ctx.strokeRect(x, y, w, h);
      break;
    }
    case 'ellipse': {
      ctx.beginPath();
      ctx.ellipse(
        x + w / 2,
        y + h / 2,
        Math.abs(w / 2),
        Math.abs(h / 2),
        0,
        0,
        Math.PI * 2
      );
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      ctx.stroke();
      break;
    }
    case 'diamond': {
      ctx.beginPath();
      ctx.moveTo(x + w / 2, y);
      ctx.lineTo(x + w, y + h / 2);
      ctx.lineTo(x + w / 2, y + h);
      ctx.lineTo(x, y + h / 2);
      ctx.closePath();
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      ctx.stroke();
      break;
    }
    case 'line':
    case 'arrow':
    case 'freedraw': {
      const pts: number[][] = Array.isArray(e.points) ? e.points : [];
      if (pts.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(x + (pts[0][0] || 0), y + (pts[0][1] || 0));
        for (let i = 1; i < pts.length; i += 1) {
          ctx.lineTo(x + (pts[i][0] || 0), y + (pts[i][1] || 0));
        }
        ctx.stroke();
        if (e.type === 'arrow') {
          const a = pts[pts.length - 2];
          const b = pts[pts.length - 1];
          const ax = x + (a[0] || 0);
          const ay = y + (a[1] || 0);
          const bx = x + (b[0] || 0);
          const by = y + (b[1] || 0);
          const ang = Math.atan2(by - ay, bx - ax);
          const len = Math.max(8, (e.strokeWidth || 1.5) * 4);
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.lineTo(
            bx - len * Math.cos(ang - Math.PI / 7),
            by - len * Math.sin(ang - Math.PI / 7)
          );
          ctx.moveTo(bx, by);
          ctx.lineTo(
            bx - len * Math.cos(ang + Math.PI / 7),
            by - len * Math.sin(ang + Math.PI / 7)
          );
          ctx.stroke();
        }
      }
      break;
    }
    case 'text': {
      const size = e.fontSize || 20;
      const family =
        e.fontFamily === 3 ? 'monospace' : e.fontFamily === 2 ? 'serif' : 'sans-serif';
      ctx.fillStyle = strokeFor(e);
      ctx.font = `${size}px ${family}`;
      ctx.textBaseline = 'top';
      const lineHeight = size * (e.lineHeight || 1.25);
      const lines = String(e.text ?? '').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        ctx.fillText(lines[i], x, y + i * lineHeight);
      }
      break;
    }
    default:
      break;
  }
  ctx.restore();
}

export async function renderExcalidrawToPng(srcPath: string): Promise<Buffer> {
  const data = JSON.parse(await fsp.readFile(srcPath, 'utf8'));
  const elements: El[] = Array.isArray(data?.elements)
    ? data.elements.filter((e: El) => e && !e.isDeleted && e.type !== 'selection')
    : [];
  const bg =
    typeof data?.appState?.viewBackgroundColor === 'string'
      ? data.appState.viewBackgroundColor
      : '#ffffff';

  // Scene bounding box (account for points on linear/freedraw elements).
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of elements) {
    const x = e.x || 0;
    const y = e.y || 0;
    const w = e.width || 0;
    const h = e.height || 0;
    let x0 = x;
    let y0 = y;
    let x1 = x + w;
    let y1 = y + h;
    if (Array.isArray(e.points)) {
      for (const p of e.points) {
        const px = x + (p[0] || 0);
        const py = y + (p[1] || 0);
        x0 = Math.min(x0, px);
        y0 = Math.min(y0, py);
        x1 = Math.max(x1, px);
        y1 = Math.max(y1, py);
      }
    }
    minX = Math.min(minX, x0);
    minY = Math.min(minY, y0);
    maxX = Math.max(maxX, x1);
    maxY = Math.max(maxY, y1);
  }
  if (!Number.isFinite(minX)) {
    // Empty scene: render a small blank canvas in the background colour.
    minX = 0;
    minY = 0;
    maxX = 256;
    maxY = 256;
  }

  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const scale = Math.min(RENDER_MAX / bw, RENDER_MAX / bh, 4);
  const cw = Math.max(1, Math.round(bw * scale) + PAD * 2);
  const ch = Math.max(1, Math.round(bh * scale) + PAD * 2);

  const canvas = getCanvas().createCanvas(cw, ch);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = bg || '#ffffff';
  ctx.fillRect(0, 0, cw, ch);
  // Map scene coords → canvas (with padding), scaling strokes/fonts too.
  ctx.setTransform(scale, 0, 0, scale, PAD - minX * scale, PAD - minY * scale);

  const count = Math.min(elements.length, MAX_ELEMENTS);
  for (let i = 0; i < count; i += 1) drawElement(ctx, elements[i]);

  return canvas.encode('png');
}
