/**
 * Shared, referentially-stable empty references.
 *
 * Use these as the fallback of a `useSelector` instead of a fresh `{}` / `[]`:
 *
 *   const tagColors = useSelector((s) => s.settings?.tagColors ?? EMPTY_OBJ);
 *
 * A fresh `{}` / `[]` literal in that spot is a *new* object on every dispatch,
 * which defeats `useSelector`'s default `Object.is` compare and forces a
 * re-render for every store update. The reducers already initialize these
 * slices (`settings.tagColors`, `taglibrary.groups`, …), so the fallback
 * rarely fires in practice — these constants are defense-in-depth and make the
 * stability intent explicit. Mirrors the per-file `EMPTY_*` constants already
 * hoisted in MapiqueView (P0-3) and FileList.
 *
 * Typed as `never` so a single constant is assignable to any `T[]` /
 * `Record<string, T>` without per-call casts.
 */
export const EMPTY_OBJ: { [k: string]: never } = {};
export const EMPTY_ARR: never[] = [];
