import { useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, Stack, Typography } from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';

import type { ThemeMode } from '-/reducers/settings';
import {
  THEME_MODE_PRESET_MAP,
  getPreset,
  type PresetPaletteVariant,
} from '-/theme/presets';

/**
 * Group container: a bordered surface holding rows that are separated by a
 * single hairline. This is the one visual language every settings section uses
 * (docs/10-ui.md §14.3/§14.4) — instead of the old mix of bare `Field` rows,
 * arbitrary `Divider`s and card-in-card layouts.
 */
export interface SettingsGroupProps {
  title?: ReactNode;
  description?: ReactNode;
  /** Right-aligned action next to the title (e.g. "Reset"). */
  action?: ReactNode;
  children: ReactNode;
}

export function SettingsGroup({
  title,
  description,
  action,
  children,
}: SettingsGroupProps) {
  return (
    <Box
      sx={{
        border: 1,
        borderColor: 'divider',
        borderRadius: 2,
        bgcolor: 'background.paper',
        overflow: 'hidden',
      }}
    >
      {title || action ? (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            px: 2,
            pt: 1.25,
            pb: 1,
          }}
        >
          <Box sx={{ flex: 1, minWidth: 0 }}>
            {title ? (
              <Typography
                variant="overline"
                component="div"
                sx={{ color: 'text.secondary', lineHeight: 1.6 }}
              >
                {title}
              </Typography>
            ) : null}
            {description ? (
              <Typography variant="caption" component="div" color="text.secondary">
                {description}
              </Typography>
            ) : null}
          </Box>
          {action}
        </Box>
      ) : null}
      <Box
        sx={{
          // Rows carry no margins of their own; the group draws the separators.
          '& > * + *': { borderTop: 1, borderColor: 'divider' },
        }}
      >
        {children}
      </Box>
    </Box>
  );
}

/**
 * A label/hint on the left and one control on the right. `fullWidth` stacks the
 * control under the label (used by long inputs such as paths and tile URLs).
 */
export interface SettingsRowProps {
  label: ReactNode;
  hint?: ReactNode;
  /** Anchor id used by settings search to scroll/highlight this row. */
  id?: string;
  fullWidth?: boolean;
  align?: 'center' | 'start';
  children?: ReactNode;
}

function RowLabel({ label }: { label: ReactNode }) {
  if (typeof label === 'string') {
    return (
      <Typography variant="body2" sx={{ fontWeight: 500 }}>
        {label}
      </Typography>
    );
  }
  return <>{label}</>;
}

function RowHint({ hint }: { hint: ReactNode }) {
  if (typeof hint === 'string') {
    return (
      <Typography variant="caption" color="text.secondary" component="div">
        {hint}
      </Typography>
    );
  }
  return <>{hint}</>;
}

export function SettingsRow({
  label,
  hint,
  id,
  fullWidth,
  align = 'center',
  children,
}: SettingsRowProps) {
  if (fullWidth) {
    return (
      <Box
        id={id}
        data-settings-row={id}
        sx={{ px: 2, py: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}
      >
        <RowLabel label={label} />
        {hint ? <RowHint hint={hint} /> : null}
        {children}
      </Box>
    );
  }

  return (
    <Stack
      id={id}
      data-settings-row={id}
      direction="row"
      sx={{
        minHeight: 56,
        px: 2,
        py: 1,
        alignItems: align === 'start' ? 'flex-start' : 'center',
        justifyContent: 'space-between',
        gap: 2,
      }}
    >
      <Stack sx={{ minWidth: 0, justifyContent: 'center' }}>
        <RowLabel label={label} />
        {hint ? <RowHint hint={hint} /> : null}
      </Stack>
      {children ? (
        <Box sx={{ flexShrink: 0, display: 'flex', alignItems: 'center' }}>
          {children}
        </Box>
      ) : null}
    </Stack>
  );
}

interface ThemePreviewPalette {
  paper: string;
  primary: string;
  secondary: string;
  text: string;
}

export interface ThemeModeOption {
  value: ThemeMode;
  labelKey: string;
  /** One entry for fixed themes, two (light+dark) for "follow the system". */
  previews: ThemePreviewPalette[];
}

function toPreview(variant: PresetPaletteVariant): ThemePreviewPalette {
  return {
    paper: variant.backgroundPaper,
    primary: variant.primary,
    secondary: variant.secondary,
    text: variant.text,
  };
}

const CURATED_IDS = [
  'warm-paper',
  'midnight-plum',
  'frosted-mint',
  'deep-ocean',
  'dawn-blush',
  'forest-ink',
  'soft-amber',
  'high-contrast',
] as const;

const WHALE = getPreset('whale');

/**
 * The single mutually-exclusive theme enum the picker offers: system, plain
 * light/dark, then the eight curated presets. `themePreset` is still dispatched
 * alongside for backwards compatibility — see GeneralSection.
 */
export const THEME_MODE_OPTIONS: ThemeModeOption[] = [
  {
    value: 'system',
    labelKey: 'system',
    previews: [toPreview(WHALE.light), toPreview(WHALE.dark)],
  },
  { value: 'light', labelKey: 'light', previews: [toPreview(WHALE.light)] },
  { value: 'dark', labelKey: 'dark', previews: [toPreview(WHALE.dark)] },
  ...CURATED_IDS.map((id) => {
    const preset = getPreset(id);
    const mode = THEME_MODE_PRESET_MAP[id].mode;
    return {
      value: id as ThemeMode,
      labelKey: preset.labelKey,
      previews: [toPreview(preset[mode])],
    };
  }),
];

function ThemePreview({ option }: { option: ThemeModeOption }) {
  return (
    <Box sx={{ display: 'flex', gap: 0.5 }}>
      {option.previews.map((palette, index) => (
        <Box
          key={index}
          sx={{
            position: 'relative',
            flex: 1,
            height: 34,
            borderRadius: 1,
            bgcolor: palette.paper,
            border: 1,
            borderColor: 'divider',
            overflow: 'hidden',
          }}
        >
          <Box
            sx={{
              position: 'absolute',
              left: 5,
              top: 5,
              width: 7,
              height: 7,
              borderRadius: '50%',
              bgcolor: palette.primary,
            }}
          />
          <Box
            sx={{
              position: 'absolute',
              left: 5,
              top: 16,
              width: 24,
              height: 4,
              borderRadius: 1,
              bgcolor: palette.text,
              opacity: 0.55,
            }}
          />
          <Box
            sx={{
              position: 'absolute',
              left: 5,
              top: 23,
              width: 15,
              height: 4,
              borderRadius: 1,
              bgcolor: palette.secondary,
              opacity: 0.5,
            }}
          />
        </Box>
      ))}
    </Box>
  );
}

/**
 * Visual theme picker (radio group). A dropdown of eleven theme names gave no
 * hint of what any theme looks like; the tiles preview each palette instead.
 */
export function ThemeModePicker({
  value,
  onChange,
}: {
  value: ThemeMode;
  onChange: (value: ThemeMode) => void;
}) {
  const { t } = useTranslation();
  const tileRefs = useRef<Array<HTMLDivElement | null>>([]);

  const move = (delta: number) => {
    const index = THEME_MODE_OPTIONS.findIndex((o) => o.value === value);
    const next =
      (index + delta + THEME_MODE_OPTIONS.length) % THEME_MODE_OPTIONS.length;
    onChange(THEME_MODE_OPTIONS[next].value);
    tileRefs.current[next]?.focus();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      onChange(THEME_MODE_OPTIONS[0].value);
      tileRefs.current[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      const last = THEME_MODE_OPTIONS.length - 1;
      onChange(THEME_MODE_OPTIONS[last].value);
      tileRefs.current[last]?.focus();
    }
  };

  return (
    <Box
      role="radiogroup"
      aria-label={t('theme')}
      onKeyDown={handleKeyDown}
      sx={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))',
        gap: 1.5,
      }}
    >
      {THEME_MODE_OPTIONS.map((option, index) => {
        const selected = option.value === value;
        return (
          <Box
            key={option.value}
            ref={(el) => {
              tileRefs.current[index] = el as HTMLDivElement | null;
            }}
            role="radio"
            aria-checked={selected}
            aria-label={t(option.labelKey)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
            sx={{
              p: 0.75,
              borderRadius: 1.5,
              border: 1,
              borderColor: selected ? 'primary.main' : 'divider',
              bgcolor: 'background.default',
              cursor: 'pointer',
              outline: 'none',
              '&:hover': { borderColor: 'primary.main' },
              '&:focus-visible': {
                outline: '2px solid',
                outlineColor: 'primary.main',
                outlineOffset: 2,
              },
            }}
          >
            <ThemePreview option={option} />
            <Stack
              direction="row"
              sx={{ alignItems: 'center', gap: 0.5, pt: 0.75, px: 0.25 }}
            >
              <Typography
                variant="caption"
                sx={{
                  flex: 1,
                  minWidth: 0,
                  fontWeight: 500,
                  fontSize: 12,
                  letterSpacing: 0,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  color: selected ? 'primary.main' : 'text.primary',
                }}
              >
                {t(option.labelKey)}
              </Typography>
              {selected ? (
                <CheckIcon sx={{ fontSize: 14, color: 'primary.main' }} />
              ) : null}
            </Stack>
          </Box>
        );
      })}
    </Box>
  );
}
