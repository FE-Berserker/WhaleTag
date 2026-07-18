/**
 * User-defined callout type for md-editor's `> [!TYPE]` Obsidian/GitHub-Alert
 * syntax. Extends the 15 built-in types (note / tip / warning / danger / …)
 * which live in md-render.ts `CALLOUT_ICON` + editor.css `.callout-{type}`.
 *
 * Stored in `settings.customCallouts` (redux-persist), pushed to the
 * md-editor iframe via the `setCustomCallouts` HostMessage. md-render's
 * `transformCallouts` merges them over the built-ins: a custom entry's
 * `type` matches `[!type]` in the markdown; its `icon` (emoji) and `color`
 * (hex) drive the rendered box. `enabled: false` falls the entry back to the
 * default icon + neutral color (effectively disabling the customization
 * without deleting it, mirroring `UserCommand.enabled`).
 *
 * Mirrors the shape of `UserCommand` in shell-types.ts (id + enabled + user
 * fields) so the Settings UI can reuse the same list/edit pattern.
 */
export interface CustomCallout {
  /** Stable id (crypto.randomUUID()) — used as React key + for update/remove. */
  id: string;
  /** The `[!type]` marker the user writes in markdown. Lowercase,
   *  `/[\w-]+/`. A custom type shadows a same-named built-in. */
  type: string;
  /** Default title shown when the marker has no explicit title
   *  (`> [!type]` with nothing after). Conventionally the type capitalized,
   *  but the user can set any label. */
  label: string;
  /** Primary color (hex, e.g. `#eab308`). Drives border + a derived lighter
   *  background (md-render mixes it toward white). */
  color: string;
  /** Emoji icon shown in the title row. */
  icon: string;
  /** Off = the custom entry is ignored (built-in/default used instead),
   *  without deleting it. */
  enabled: boolean;
}
