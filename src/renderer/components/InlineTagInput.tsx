import { useState, useMemo } from 'react';
import { Chip, InputBase, Stack, Typography } from '@mui/material';
import { useSelector } from 'react-redux';
import type { TFunction } from 'i18next';

import type { TagGroup } from '../domain/tag-library';
import { getTagColor } from '../domain/tag-colors';
import { withoutGeoTags } from '../domain/geo-tag';
import type { RootState } from '-/reducers';
import { chipSx } from '-/services/tag-display';
import { useTagDisplayLabels } from '-/hooks/useTagDisplayLabels';

/**
 * Inline chip-style tag editor used by the Mapique detail panel and the
 * PropertiesTray (file properties panel).
 *
 * Layout: existing tags render as removable chips, followed by an inline text
 * input that grows to fill the remaining space — the classic "token input"
 * pattern. Typing accumulates in the input until the user commits via
 * Enter / Space / Blur, at which point the typed string becomes a fresh chip
 * and the input clears immediately (no text piling up).
 *
 * Backspace on an empty input removes the last chip — the standard tag-input
 * affordance for "I meant to delete, not backspace-edit".
 *
 * Geo coordinate tags are intentionally hidden here: they're authored by the
 * map, not typed.
 */
export default function InlineTagInput({
  tags,
  tagColors,
  groups,
  t,
  onAdd,
  onRemove,
  readOnly = false,
}: {
  tags: string[];
  tagColors: Record<string, string>;
  groups: TagGroup[];
  t: TFunction;
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
  readOnly?: boolean;
}) {
  const tagShape = useSelector(
    (s: RootState) => s.settings?.tagShape ?? 'rounded'
  );
  const [input, setInput] = useState('');
  // Memoized so `useTagDisplayLabels`' internal memos hold across renders.
  const visibleTags = useMemo(() => withoutGeoTags(tags), [tags]);
  // docs/03: freshness-aware labels — a date-family chip flips its label on
  // the per-minute tick (subscribed only when a date-shaped tag is shown).
  const labels = useTagDisplayLabels(visibleTags);

  const commit = () => {
    const tag = input.trim();
    if (tag) onAdd(tag);
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      commit();
    } else if (
      e.key === 'Backspace' &&
      input === '' &&
      visibleTags.length > 0
    ) {
      // Standard token-input affordance: Backspace on empty input deletes
      // the most recently added chip.
      e.preventDefault();
      onRemove(visibleTags[visibleTags.length - 1]);
    }
  };

  const focusInput = (e: React.MouseEvent<HTMLDivElement>) => {
    // Clicking the container background focuses the inline input so the user
    // doesn't have to aim at the small text cursor. Skipping clicks on the
    // chip's delete icon avoids stealing focus mid-removal.
    const target = e.target as HTMLElement;
    if (target.closest('.MuiChip-deleteIcon')) return;
    const inputEl =
      e.currentTarget.querySelector<HTMLInputElement>('input[data-tag-input]');
    inputEl?.focus();
  };

  return (
    <Stack
      direction="row"
      onClick={readOnly ? undefined : focusInput}
      sx={{
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 0.5,
        px: 1.5,
        py: 1,
        minHeight: 40,
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        bgcolor: readOnly ? 'action.hover' : 'background.paper',
        cursor: readOnly ? 'default' : 'text',
        transition: 'border-color 0.15s',
        '&:focus-within': {
          borderColor: readOnly ? 'divider' : 'primary.main',
        },
      }}
    >
      {visibleTags.map((tag, i) => (
        <Chip
          key={tag}
          label={labels[i]}
          size="small"
          onDelete={readOnly ? undefined : () => onRemove(tag)}
          sx={chipSx(getTagColor(tag, tagColors, groups), false, tagShape)}
        />
      ))}
      {!readOnly && (
        <InputBase
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => input.trim() && commit()}
          placeholder={
            visibleTags.length === 0 ? t('addTagPlaceholder') : ''
          }
          inputProps={{ 'data-tag-input': true }}
          sx={{
            flex: 1,
            minWidth: 80,
            fontSize: 13,
            py: 0.25,
            '& input': { p: 0 },
          }}
        />
      )}
      {visibleTags.length === 0 && readOnly && (
        <Typography variant="caption" color="text.secondary">
          {t('noTagsYet')}
        </Typography>
      )}
    </Stack>
  );
}