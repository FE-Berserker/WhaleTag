import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from '@mui/material';

import { RootState } from '-/reducers';
import { setTagColor } from '-/reducers/settings';
import { TAG_PALETTE, readableTextOn } from '../domain/tag-colors';
import { useLocationTagLibrary } from '-/hooks/LocationTagLibraryContextProvider';

interface TagMetaDialogProps {
  open: boolean;
  tag: string;
  onClose: () => void;
}

/**
 * Edits a tag's metadata: color (palette, with a clear option) and a free-form
 * description. Self-contained — reads the current values from settings and
 * dispatches the updates itself, so callers just open it with a tag name.
 * Reached from a tag's right-click.
 */
export default function TagMetaDialog({ open, tag, onClose }: TagMetaDialogProps) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const { descriptions, setDescription } = useLocationTagLibrary();
  const explicitColor = useSelector(
    (s: RootState) => s.settings?.tagColors?.[tag]
  );
  const description = descriptions[tag] ?? '';

  const [color, setColor] = useState<string | null>(explicitColor ?? null);
  const [desc, setDesc] = useState(description);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Re-sync local state each time the dialog opens (or the target tag changes).
  useEffect(() => {
    if (open) {
      setColor(explicitColor ?? null);
      setDesc(description);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tag]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      dispatch(setTagColor(tag, color));
      await setDescription(tag, desc);
      onClose();
    } catch (e) {
      // Keep the dialog open so the user can retry; show WHY inline (the
      // catch used to be empty, so a failed save looked like a no-op).
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>
        {t('editTag')}
        <Typography component="span" variant="body2" color="text.secondary">
          {' '}
          — {tag}
        </Typography>
      </DialogTitle>
      <DialogContent>
        <Typography variant="caption" color="text.secondary">
          {t('changeColor')}
        </Typography>
        <Box
          sx={{
            display: 'flex',
            gap: 0.75,
            flexWrap: 'wrap',
            maxWidth: 240,
            mt: 0.5,
            mb: 2,
          }}
        >
          {TAG_PALETTE.map((c) => {
            const selected = color === c;
            return (
              <Box
                key={c}
                component="button"
                type="button"
                aria-label={c}
                aria-pressed={selected}
                onClick={() => setColor(c)}
                sx={{
                  width: 26,
                  height: 26,
                  borderRadius: '50%',
                  bgcolor: c,
                  cursor: 'pointer',
                  border: selected ? 2 : 1,
                  borderColor: selected ? 'text.primary' : 'divider',
                  boxShadow: selected ? '0 0 0 2px rgba(0,0,0,0.15)' : 'none',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: readableTextOn(c),
                  fontSize: 14,
                  fontWeight: 700,
                  p: 0,
                  '&:hover': { transform: 'scale(1.1)' },
                  '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineStyle: 'solid', outlineOffset: 2 },
                  transition: 'transform 0.1s',
                }}
              >
                {selected ? '✓' : ''}
              </Box>
            );
          })}
          <Box
            component="button"
            type="button"
            aria-label={t('clearColor')}
            onClick={() => setColor(null)}
            title={t('clearColor')}
            sx={{
              width: 26,
              height: 26,
              borderRadius: '50%',
              cursor: 'pointer',
              border: color === null ? 2 : 1,
              borderColor: color === null ? 'text.primary' : 'divider',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 12,
              color: 'text.secondary',
              bgcolor: 'background.paper',
              p: 0,
              '&:hover': { transform: 'scale(1.1)' },
              '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineStyle: 'solid', outlineOffset: 2 },
              transition: 'transform 0.1s',
            }}
          >
            ✕
          </Box>
        </Box>

        <Typography variant="caption" color="text.secondary">
          {t('tagDescription')}
        </Typography>
        <TextField
          fullWidth
          multiline
          minRows={2}
          maxRows={5}
          margin="dense"
          placeholder={t('tagDescriptionPlaceholder')}
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void save();
          }}
        />
        {saveError ? (
          <Alert severity="error" sx={{ mt: 1 }} onClose={() => setSaveError(null)}>
            {saveError}
          </Alert>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={onClose} disabled={saving}>
          {t('cancel')}
        </Button>
        <Button variant="contained" onClick={() => void save()} disabled={saving}>
          {t('save')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
