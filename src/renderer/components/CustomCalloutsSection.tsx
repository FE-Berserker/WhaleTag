import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import {
  Box,
  Button,
  IconButton,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';

import { setCustomCallouts } from '-/reducers/settings';
import type { RootState } from '-/reducers';
import type { CustomCallout } from '../../shared/callout-types';

/**
 * Manage user-defined callout types for md-editor's `> [!TYPE]` syntax
 * (extends the 15 built-ins). The built-ins are shown as read-only rendered
 * previews so the user can see what each `[!type]` looks like; custom entries
 * get the same preview treatment plus enable/delete controls.
 */

/** 6 callout hue groups — github-light palette, mirrors md-editor editor.css
 *  `--md-callout-{hue}-border` / `-bg` (the `:root` defaults). The renderer
 *  can't import the extension's CSS, so the palette is duplicated here; if the
 *  extension palette changes, update these too. */
const CALLOUT_COLORS: Record<string, { border: string; bg: string }> = {
  blue: { border: '#0969da', bg: '#ddf4ff' },
  green: { border: '#1a7f37', bg: '#dafbe1' },
  orange: { border: '#9a6700', bg: '#fff8c5' },
  red: { border: '#cf222e', bg: '#ffebe9' },
  purple: { border: '#8250df', bg: '#fbefff' },
  gray: { border: '#57606a', bg: '#f6f8fa' },
};

/** 15 built-in callout types (icon + hue), mirrors md-render.ts `CALLOUT_ICON`
 *  + editor.css `.callout-{type}` hue groups. */
const BUILTIN_CALLOUTS: { type: string; icon: string; hue: string }[] = [
  { type: 'note', icon: '📝', hue: 'blue' },
  { type: 'tip', icon: '💡', hue: 'green' },
  { type: 'important', icon: '❗', hue: 'purple' },
  { type: 'warning', icon: '⚠️', hue: 'orange' },
  { type: 'caution', icon: '🚫', hue: 'red' },
  { type: 'info', icon: 'ℹ️', hue: 'blue' },
  { type: 'success', icon: '✅', hue: 'green' },
  { type: 'question', icon: '❓', hue: 'blue' },
  { type: 'danger', icon: '🔥', hue: 'red' },
  { type: 'bug', icon: '🐛', hue: 'red' },
  { type: 'example', icon: '📋', hue: 'purple' },
  { type: 'quote', icon: '💬', hue: 'gray' },
  { type: 'abstract', icon: '📄', hue: 'purple' },
  { type: 'failure', icon: '❌', hue: 'red' },
  { type: 'todo', icon: '✔️', hue: 'blue' },
];

/** Emoji presets for the icon picker — the 15 built-in callout icons plus a
 *  spread of generally-useful ones, so the user can click-to-pick instead of
 *  hunting down an emoji to paste into the text field. */
const EMOJI_PRESETS = [
  '📝', '💡', '❗', '⚠️', '🚫', 'ℹ️', '✅', '❓',
  '🔥', '🐛', '📋', '💬', '📄', '❌', '✔️', '⭐',
  '🔔', '📌', '🎨', '🚀', '❤️', '👍', '🎯', '📊',
  '🔍', '⚙️', '🛠️', '🏆', '🔒',
];

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A rendered callout preview box (icon + title + the `[!type]` syntax line),
 *  styled to mirror md-editor's `.callout` (border-left accent + tinted bg). */
function CalloutPreview({
  icon,
  label,
  type,
  colors,
}: {
  icon: string;
  label: string;
  type: string;
  colors: { border: string; bg: string };
}): JSX.Element {
  return (
    <Box
      sx={{
        border: `1px solid ${colors.border}`,
        borderLeft: `4px solid ${colors.border}`,
        background: colors.bg,
        borderRadius: '4px',
        padding: '6px 10px',
      }}
    >
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {icon} {label}
      </Typography>
      <Typography
        variant="caption"
        sx={{ opacity: 0.7, fontFamily: 'monospace' }}
      >
        {`> [!${type}]`}
      </Typography>
    </Box>
  );
}

export default function CustomCalloutsSection(): JSX.Element {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const callouts = useSelector((s: RootState) => s.settings.customCallouts);

  const [type, setType] = useState('');
  const [label, setLabel] = useState('');
  const [color, setColor] = useState('#0969da');
  const [icon, setIcon] = useState('📝');

  const resetForm = () => {
    setType('');
    setLabel('');
    setColor('#0969da');
    setIcon('📝');
  };

  const add = () => {
    // `type` must be lowercase [\w-]+ — it becomes the `[!type]` marker.
    const trimmed = type.trim().toLowerCase();
    if (!trimmed || !/^[\w-]+$/.test(trimmed)) return;
    const next: CustomCallout[] = [
      ...callouts,
      {
        id: crypto.randomUUID(),
        type: trimmed,
        label: label.trim() || trimmed,
        color: color.trim() || '#0969da',
        icon: icon.trim() || '📝',
        enabled: true,
      },
    ];
    dispatch(setCustomCallouts(next));
    resetForm();
  };

  const update = (id: string, patch: Partial<CustomCallout>) => {
    dispatch(
      setCustomCallouts(
        callouts.map((c) => (c.id === id ? { ...c, ...patch } : c))
      )
    );
  };

  const remove = (id: string) => {
    dispatch(setCustomCallouts(callouts.filter((c) => c.id !== id)));
  };

  return (
    <>
      <Typography variant="subtitle2">{t('calloutsTitle')}</Typography>
      <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5 }}>
        {t('calloutsHint')}
      </Typography>

      {/* Built-in callouts — read-only rendered previews. */}
      <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }}>
        {t('calloutBuiltin')}
      </Typography>
      <Stack spacing={0.5}>
        {BUILTIN_CALLOUTS.map((c) => (
          <CalloutPreview
            key={c.type}
            icon={c.icon}
            label={capitalize(c.type)}
            type={c.type}
            colors={CALLOUT_COLORS[c.hue]}
          />
        ))}
      </Stack>

      {/* Custom callouts — preview + enable/delete. */}
      <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }}>
        {t('calloutCustom')}
      </Typography>
      {callouts.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {t('calloutEmpty')}
        </Typography>
      ) : (
        <Stack spacing={0.5}>
          {callouts.map((c) => {
            // Custom bg = the hex + low alpha (mirrors md-render's tint toward
            // white). A disabled entry falls back to neutral gray.
            const colors = c.enabled
              ? { border: c.color, bg: `${c.color}22` }
              : CALLOUT_COLORS.gray;
            return (
              <Stack
                key={c.id}
                direction="row"
                spacing={1}
                sx={{ alignItems: 'center' }}
              >
                <Switch
                  size="small"
                  checked={c.enabled}
                  onChange={(e) =>
                    update(c.id, { enabled: e.target.checked })
                  }
                />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <CalloutPreview
                    icon={c.icon}
                    label={c.label || capitalize(c.type)}
                    type={c.type}
                    colors={colors}
                  />
                </Box>
                <Tooltip title={t('remove')}>
                  <IconButton size="small" onClick={() => remove(c.id)}>
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
            );
          })}
        </Stack>
      )}

      {/* Add form — same shape as before (type/icon/label/color). Rows are
          top-aligned (`flex-start`) so fields with helper text don't push
          their row-mates off-center (was `center`, which made the icon /
          color controls float mid-row — the "not aligned" complaint). */}
      <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
          <TextField
            size="small"
            label={t('calloutType')}
            placeholder="star"
            helperText={t('calloutTypeHint')}
            value={type}
            onChange={(e) => setType(e.target.value)}
            sx={{ flex: 1 }}
          />
          <TextField
            size="small"
            label={t('calloutIcon')}
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
            sx={{ width: 120 }}
          />
        </Stack>
        {/* Emoji picker — click to set the icon (alternative to typing). */}
        <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.5 }}>
          {EMOJI_PRESETS.map((e) => (
            <Button
              key={e}
              size="small"
              onClick={() => setIcon(e)}
              sx={{
                minWidth: 0,
                px: 0.5,
                py: 0.25,
                fontSize: 18,
                lineHeight: 1,
                border: icon === e ? '2px solid' : '1px solid',
                borderColor: icon === e ? 'primary.main' : 'divider',
              }}
            >
              {e}
            </Button>
          ))}
        </Stack>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
          <TextField
            size="small"
            label={t('calloutLabel')}
            helperText={t('calloutLabelHint')}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            sx={{ flex: 1 }}
          />
          <Stack
            direction="row"
            spacing={0.5}
            sx={{ alignItems: 'center', height: 40 }}
          >
            <input
              type="color"
              value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : '#0969da'}
              onChange={(e) => setColor(e.target.value)}
              title={t('calloutColor')}
              style={{
                width: 40,
                height: 40,
                padding: 0,
                border: '1px solid rgba(127,127,127,0.4)',
                borderRadius: 4,
                cursor: 'pointer',
                background: 'transparent',
              }}
            />
            <Typography variant="caption" color="text.secondary">
              {t('calloutColor')}
            </Typography>
          </Stack>
        </Stack>
        <Button
          size="small"
          variant="outlined"
          startIcon={<AddIcon />}
          sx={{ alignSelf: 'flex-start' }}
          onClick={add}
        >
          {t('calloutAdd')}
        </Button>
      </Box>
    </>
  );
}
