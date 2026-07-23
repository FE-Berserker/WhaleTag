import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';

export type ConfirmDiscardChoice = 'save' | 'discard' | 'cancel';

interface ConfirmDiscardDialogProps {
  open: boolean;
  fileName: string;
  onChoose: (choice: ConfirmDiscardChoice) => void;
}

/**
 * Three-way "unsaved changes" confirmation shown before closing an editor view
 * whose document has unsaved edits (driven by `requestCloseCurrent` in
 * ExtensionContextProvider). Mirrors VSCode / Typora:
 *   - Save       → write the document, then close
 *   - Don't Save → close, dropping the edits
 *   - Cancel     → stay in the document
 *
 * The `Dialog` `onClose` (fired by ESC + backdrop click) is routed to
 * `cancel` — without that, MUI hides the dialog internally while the
 * Promise driving it (`confirmDiscard`) hangs forever.
 */
export default function ConfirmDiscardDialog({
  open,
  fileName,
  onChoose,
}: ConfirmDiscardDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onClose={() => onChoose('cancel')} maxWidth="xs" fullWidth>
      <DialogTitle>{t('unsavedChangesTitle')}</DialogTitle>
      <DialogContent>
        <Typography>{t('confirmCloseUnsavedBody', { name: fileName })}</Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => onChoose('cancel')}>{t('cancel')}</Button>
        <Button color="inherit" onClick={() => onChoose('discard')}>
          {t('dontSave')}
        </Button>
        <Button variant="contained" onClick={() => onChoose('save')} autoFocus>
          {t('save')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
