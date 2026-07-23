/**
 * Marquee (box-select) geometry + text extraction helpers for the PDF
 * viewer's "ask AI about this region" feature. Pure functions over plain
 * span descriptors (read off the textLayer's absolutely-positioned DOM
 * spans), so the whole extraction is unit-testable without pdfjs or a DOM.
 */

export interface MarqueeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A textLayer span reduced to numbers (px, page-container coordinates). */
export interface SpanBox {
  left: number;
  top: number;
  width: number;
  height: number;
  text: string;
}

/** Normalize a drag from (x1,y1) to (x2,y2) into a top-left-anchored rect. */
export function rectFromPoints(
  x1: number,
  y1: number,
  x2: number,
  y2: number
): MarqueeRect {
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  return {
    left,
    top,
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

function intersects(a: MarqueeRect, s: SpanBox): boolean {
  return (
    s.left < a.left + a.width &&
    s.left + s.width > a.left &&
    s.top < a.top + a.height &&
    s.top + s.height > a.top
  );
}

/** Spans whose box intersects the marquee, in their original (DOM) order. */
export function spansInRect(spans: SpanBox[], rect: MarqueeRect): SpanBox[] {
  return spans.filter((s) => intersects(rect, s));
}

/**
 * Assemble hit spans into reading-order text. Spans are grouped into lines
 * by `top` proximity (half the median span height); spans within a line are
 * joined in `left` order with a space (pdfjs emits one span per text run,
 * often mid-word). Lines are joined with `\n`. Duplicate-space-safe: a span
 * that already starts/ends with whitespace is concatenated without an extra
 * separator.
 */
export function spansToText(spans: SpanBox[]): string {
  if (spans.length === 0) return '';
  const sorted = [...spans].sort((a, b) => a.top - b.top || a.left - b.left);
  // Median height as the line-proximity reference (robust to a stray huge
  // heading span on the page).
  const heights = sorted.map((s) => s.height).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] || 1;
  const lineTolerance = median * 0.5;

  const lines: SpanBox[][] = [];
  for (const span of sorted) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(span.top - line[0].top) <= lineTolerance) {
      line.push(span);
    } else {
      lines.push([span]);
    }
  }
  return lines
    .map((line) =>
      line
        .sort((a, b) => a.left - b.left)
        .map((s) => s.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter((line) => line.length > 0)
    .join('\n');
}
