/**
 * Tag library data structures, shared across the renderer (reducer +
 * components). Lives in shared/ so the pure color helpers in tag-colors.ts can
 * depend on TagGroup without a layering cycle (shared must not import renderer).
 */

/** A named, persisted group of predefined tags. */
export interface TagGroup {
  id: string;
  title: string;
  expanded: boolean;
  /**
   * Optional group color. Tags inside the group inherit it when they don't
   * have their own explicit color (see getTagColor's three-tier fallback).
   */
  color?: string;
  tags: string[];
}
