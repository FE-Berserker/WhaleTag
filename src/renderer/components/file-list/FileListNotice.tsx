import type { TFunction } from 'i18next';
import { Alert, Button, Snackbar } from '@mui/material';

import { ipcApi } from '-/services/ipc-api';
import { errorMessage } from '-/services/errors';

/**
 * Structured notice state for `FileList` (P2 FileList split). Severity is
 * decided at the call site, never inferred from the localized text
 * (prefix-matching translations mislabeled error toasts as success in ja/ko
 * and success toasts as errors in en/zh).
 */
export interface FileListNotice {
  text: string;
  severity: 'success' | 'info' | 'warning' | 'error';
  /** Show the "open trash" action button. */
  openTrash?: boolean;
  /** Show a revealed corrupt-sidecar backup. */
  backupPath?: string;
}

export interface FileListNoticeSnackbarProps {
  notice: FileListNotice | null;
  onClose: () => void;
  showNotice: (
    text: string,
    severity?: FileListNotice['severity']
  ) => void;
  t: TFunction;
}

/**
 * Bottom-center snackbar for `FileList`'s notices. Kept null-safe because
 * Snackbar keeps its child mounted while closed (exit transition), so every
 * read here runs even though `open` is false.
 */
export default function FileListNoticeSnackbar({
  notice,
  onClose,
  showNotice,
  t,
}: FileListNoticeSnackbarProps) {
  return (
    <Snackbar
      open={notice !== null}
      autoHideDuration={6000}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
    >
      <Alert
        severity={notice?.severity ?? 'info'}
        variant="filled"
        onClose={onClose}
        action={
          notice?.backupPath ? (
            <Button
              color="inherit"
              size="small"
              onClick={() => {
                void ipcApi
                  .revealAndSelect(notice.backupPath!)
                  .catch((e) =>
                    showNotice(
                      t('operationFailed', { message: errorMessage(e) })
                    )
                  );
              }}
            >
              {t('sidecarRevealBackup')}
            </Button>
          ) : notice?.openTrash ? (
            <Button
              color="inherit"
              size="small"
              onClick={() => {
                void ipcApi
                  .openTrash()
                  .catch((e) =>
                    showNotice(
                      t('operationFailed', { message: errorMessage(e) })
                    )
                  );
              }}
            >
              {t('openTrash')}
            </Button>
          ) : undefined
        }
      >
        {notice?.text ?? ''}
      </Alert>
    </Snackbar>
  );
}
