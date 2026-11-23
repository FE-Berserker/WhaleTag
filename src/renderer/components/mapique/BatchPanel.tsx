import { useMemo, useState } from 'react';
import { Box, Button, Chip, Stack, TextField, Typography } from '@mui/material';
import { useSelector } from 'react-redux';
import type { TFunction } from 'i18next';

import type { DirEntry } from '../../../shared/ipc-types';
import type { TagGroup } from '../../domain/tag-library';
import { getTagColor } from '../../domain/tag-colors';
import type { RootState } from '-/reducers';
import { chipSx, tagDisplayLabel } from '-/services/tag-display';

export default function BatchPanel({
  entries,
  tagsByName,
  tagColors,
  groups,
  t,
  canEdit,
  onAddTag,
  onRemoveTag,
  onClearGeo,
}: {
  entries: DirEntry[];
  tagsByName: Map<string, string[]>;
  tagColors: Record<string, string>;
  groups: TagGroup[];
  t: TFunction;
  canEdit: boolean;
  onAddTag?: (entry: DirEntry, tag: string) => void;
  onRemoveTag?: (entry: DirEntry, tag: string) => void;
  onClearGeo?: (entry: DirEntry) => void;
}) {
  const [input, setInput] = useState('');
  const tagShape = useSelector(
    (s: RootState) => s.settings?.tagShape ?? 'rounded'
  );

  // Tags common to every selected file (intersection).
  const commonTags = useMemo(() => {
    if (entries.length === 0) return [];
    const sets = entries.map((e) => new Set(tagsByName.get(e.path) ?? []));
    const first = sets[0];
    return [...first].filter((tag) => sets.every((s) => s.has(tag)));
  }, [entries, tagsByName]);

  const commit = () => {
    const tag = input.trim();
    if (!tag) return;
    entries.forEach((entry) => onAddTag?.(entry, tag));
    setInput('');
  };

  return (
    <Stack spacing={0} sx={{ py: 1 }}>
      <Typography variant="subtitle2" sx={{ px: 1.5, pb: 1 }}>
        {t('nSelected', { count: entries.length })}
      </Typography>

      {canEdit && (
        <Button
          size="small"
          variant="outlined"
          color="error"
          sx={{ mx: 1.5, mb: 1, alignSelf: 'flex-start' }}
          onClick={() => entries.forEach((e) => onClearGeo?.(e))}
        >
          {t('clearLocation')}
        </Button>
      )}

      {commonTags.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, px: 1.5, pb: 1 }}>
          {commonTags.map((tag) => (
            <Chip
              key={tag}
              label={tagDisplayLabel(tag, t)}
              size="small"
              onDelete={canEdit ? () => entries.forEach((e) => onRemoveTag?.(e, tag)) : undefined}
              sx={chipSx(getTagColor(tag, tagColors, groups), false, tagShape)}
            />
          ))}
        </Box>
      )}

      {canEdit && (
        <TextField
          size="small"
          fullWidth
          placeholder={t('addTagToSelection')}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              commit();
            }
          }}
          onBlur={() => input.trim() && commit()}
          sx={{ px: 1.5 }}
        />
      )}
    </Stack>
  );
}
