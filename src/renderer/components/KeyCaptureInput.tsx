import { useTranslation } from 'react-i18next';
import { normalizeCombo, formatCombo } from '../domain/md-keybindings';

/**
 * A read-only input that captures the next key combo on keydown and turns it
 * into a CodeMirror combo string (`Mod-s` / `Mod-Shift-z` / …) via
 * `normalizeCombo`. The renderer's existing KeyboardSection uses MUI Select
 * dropdowns (no modifier support), which can't express `Mod-` combos — this
 * component exists specifically for the md-editor keymap panel.
 *
 * - Press a `Mod-…` combo → `onChange(combo)`.
 * - Backspace / Delete / Escape → `onChange('')` (unbind the action).
 * - Bare key (no Mod) / pure modifier → ignored (keep listening).
 *
 * Uses a raw `<input>` (styled inline) rather than MUI TextField: TextField's
 * `inputProps.onKeyDown` typing collides with its Standard/Outlined/Filled
 * union and degrades the handler to `any`. A raw input has a clean
 * `KeyboardEvent<HTMLInputElement>` and inherits color/font from the Settings
 * dialog for theme adaptation.
 */
interface Props {
  value: string;
  onChange: (combo: string) => void;
  conflict?: boolean;
}

export function KeyCaptureInput({ value, onChange, conflict }: Props) {
  const { t } = useTranslation();
  const isMac =
    typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
  const display = value ? formatCombo(value, isMac) : t('mdKeyNone');
  return (
    <input
      type="text"
      readOnly
      value={display}
      placeholder={t('mdKeyCapturing')}
      title={conflict ? t('mdKeyConflict') : undefined}
      aria-label={display}
      onKeyDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (
          e.key === 'Backspace' ||
          e.key === 'Delete' ||
          e.key === 'Escape'
        ) {
          onChange('');
          return;
        }
        const combo = normalizeCombo(e.nativeEvent);
        if (combo === null) return; // pure modifier / no Mod — keep listening
        onChange(combo);
      }}
      style={{
        width: 190,
        height: 40,
        boxSizing: 'border-box',
        padding: '0 10px',
        display: 'block',
        fontSize: 14,
        fontFamily: 'inherit',
        border: `1px solid ${conflict ? '#d32f2f' : 'rgba(127,127,127,0.4)'}`,
        borderRadius: 4,
        cursor: 'pointer',
        background: 'transparent',
        // Empty ("无" / unbound) reads dimmer than a real combo so the two
        // states don't look like two different control styles in one column.
        color: value ? 'inherit' : 'rgba(127,127,127,0.75)',
        outline: 'none',
      }}
    />
  );
}
