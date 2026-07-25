/**
 * User-defined HTML snippet template for md-editor. Each appears as an entry in
 * the editor's right-click "Templates" submenu; selecting one inserts
 * `template` at the cursor via `view.state.replaceSelection`.
 *
 * Stored in `settings.mdTemplates` (redux-persist), pushed to the md-editor
 * iframe via the `setMdTemplates` HostMessage (same host→iframe channel as
 * `setCustomCallouts`). The inserted HTML is rendered through md-editor's
 * existing marked + DOMPurify pipeline (`FORBID_ATTR: ['style']` + allow-list),
 * so inline `style` is stripped and only safe tags / attributes (incl. `class`)
 * survive — no DOMPurify config change, no new XSS surface.
 *
 * Mirrors the shape of `CustomCallout` (id + enabled + user fields) and
 * `UserCommand` so the Settings UI reuses the same list / toggle / delete
 * pattern.
 */
export interface MdTemplate {
  /** Stable id (crypto.randomUUID()) — React key + update/remove target. */
  id: string;
  /** Label shown in the right-click Templates submenu. */
  label: string;
  /** HTML snippet inserted at the cursor (sanitized on preview). */
  template: string;
  /** Off = hidden from the submenu without deleting (mirrors UserCommand.enabled). */
  enabled: boolean;
}
