import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSelector } from 'react-redux';
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import { ipcApi } from '-/services/ipc-api';
import type { RootState } from '-/reducers';
import { buildAiSnapshot } from './buildSnapshot';

interface InlineEditModalProps {
  open: boolean;
  selection: string;
  onClose: () => void;
  /** Called with the AI replacement; the host applies it to the editor. */
  onApplied: (replacement: string) => void;
}

/**
 * Instruction input for an inline edit of the editor's current selection.
 * Calls `ai:inlineEdit` (HTTP providers) and hands the replacement back to the
 * host, which writes it into the CodeMirror selection.
 */
export default function InlineEditModal({
  open,
  selection,
  onClose,
  onApplied,
}: InlineEditModalProps) {
  const { t } = useTranslation();
  const settings = useSelector((s: RootState) => s.settings);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async () => {
    const trimmed = instruction.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { replacement } = await ipcApi.aiInlineEdit({
        settings: buildAiSnapshot(settings),
        selection,
        instruction: trimmed,
      });
      if (replacement) {
        onApplied(replacement);
        setInstruction('');
        onClose();
      } else {
        // Empty reply across all providers now means the same thing — the
        // model returned nothing usable (network failure / empty model reply
        // / missing Claude CLI). The Claude path used to return '' unconditionally
        // and surface as "switch provider"; it now genuinely attempts the edit.
        setError(
          settings.aiProvider === 'claude-cli'
            ? t('aiInlineEditClaudeEmpty')
            : t('aiInlineEditEmpty')
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('aiInlineEditTitle')}</DialogTitle>
      <DialogContent>
        <Stack spacing={1.5}>
          <Box
            component="pre"
            sx={{
              m: 0,
              p: 1,
              maxHeight: 120,
              overflow: 'auto',
              bgcolor: 'action.hover',
              borderRadius: 0.5,
              fontSize: 12,
              whiteSpace: 'pre-wrap',
            }}
          >
            {selection}
          </Box>
          <TextField
            autoFocus
            size="small"
            fullWidth
            placeholder={t('aiInlineEditPlaceholder')}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void apply();
              }
            }}
          />
          {error ? (
            <Typography variant="caption" color="error.main">
              {error}
            </Typography>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button color="inherit" disabled={busy} onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button
          variant="contained"
          disabled={busy || !instruction.trim()}
          onClick={() => void apply()}
          startIcon={busy ? <CircularProgress size={14} /> : undefined}
        >
          {t('aiInlineEditApply')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
