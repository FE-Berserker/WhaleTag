import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import type { AiDraftPayload } from './aiDraftBus';

interface AskQuestionDialogProps {
  /** The pdf-viewer marquee payload (null = closed). */
  draft: AiDraftPayload | null;
  onClose: () => void;
  /** Confirmed with the (user-edited) question — the host forwards it to the AI panel. */
  onSend: (question: string) => void;
}

/**
 * Question editor for the pdf-viewer marquee "ask AI" — same shell pattern as
 * InlineEditModal (✨ in text/md editors): the user EDITS the prefilled
 * question before it is sent with the boxed text/screenshot, instead of a
 * hardcoded prompt firing on click.
 */
export default function AskQuestionDialog({
  draft,
  onClose,
  onSend,
}: AskQuestionDialogProps) {
  const { t } = useTranslation();
  const [question, setQuestion] = useState('');

  // Reset the editable default each time a new draft arrives.
  useEffect(() => {
    if (draft) setQuestion(t('aiPdfAutoAsk'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const send = () => {
    const q = question.trim();
    if (!q) return;
    onSend(q);
  };

  const preview = draft?.text ?? '';
  const page = draft?.page;

  return (
    <Dialog open={draft !== null} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{t('aiAskQuestionTitle')}</DialogTitle>
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
            {preview
              ? preview.slice(0, 600)
              : t('aiPdfScreenshot', { page: page ?? '?' })}
          </Box>
          <TextField
            autoFocus
            size="small"
            fullWidth
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <Typography variant="caption" color="text.secondary">
            {t('aiAskQuestionHint')}
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={onClose}>
          {t('cancel')}
        </Button>
        <Button
          variant="contained"
          disabled={!question.trim()}
          onClick={send}
        >
          {t('aiSend')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
