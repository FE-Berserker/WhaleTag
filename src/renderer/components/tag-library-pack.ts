/**
 * Row-packing math for the TagLibrary virtualization (docs/03 §12): the
 * plain-tag chips are variable-width, so a react-window `List` can't take a
 * fixed items-per-row — chips are greedily packed into rows that fit the
 * measured container width, and the list virtualizes those rows.
 *
 * Width model (kept pessimistic on purpose — overestimating a chip just
 * underfills a row; underestimating would wrap it onto a second visual line
 * and break the measured row height):
 *  - fontSize 11 system-ui latin ≈ 6.4px/char; CJK ≈ double (counted ×2)
 *  - count digits ≈ 7px each; padding + count + row gap ≈ 34px base
 */

export interface TagCount {
  tag: string;
  count: number;
}

export interface ChipRow {
  kind: 'chips';
  tags: TagCount[];
}

export type PackedRow = ChipRow | { kind: 'cluster' };

export const EST_CHIP_ROW_HEIGHT = 28;
export const EST_CLUSTER_ROW_HEIGHT = 56;

/** Estimated pixel width of one chip (tag + its count). */
export function estChipWidth(tag: string, count: number): number {
  let units = 0;
  for (const ch of tag) units += (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
  return Math.ceil(units * 6.4 + String(count).length * 7 + 34);
}

/**
 * Greedily pack `tags` into rows that fit `containerWidth`. Every row keeps
 * at least one chip (a chip wider than the container gets its own row —
 * visual overflow is then confined to that chip, matching the pre-
 * virtualization wrap behavior as closely as possible).
 */
export function packTagRows(
  tags: TagCount[],
  containerWidth: number,
  gap = 6
): ChipRow[] {
  const rows: ChipRow[] = [];
  let current: TagCount[] = [];
  let used = 0;
  const budget = Math.max(80, containerWidth);
  for (const tc of tags) {
    const w = estChipWidth(tc.tag, tc.count);
    const would = used === 0 ? w : used + gap + w;
    if (used > 0 && would > budget) {
      rows.push({ kind: 'chips', tags: current });
      current = [tc];
      used = w;
    } else {
      current.push(tc);
      used = would;
    }
  }
  if (current.length > 0) rows.push({ kind: 'chips', tags: current });
  return rows;
}

/** Total estimated height of the packed rows + the optional leading cluster
 *  row — the virtual list's height (panel shrinks to content when short). */
export function estListHeight(rows: PackedRow[]): number {
  let h = 0;
  for (const r of rows) {
    h += r.kind === 'cluster' ? EST_CLUSTER_ROW_HEIGHT : EST_CHIP_ROW_HEIGHT;
  }
  return h;
}
