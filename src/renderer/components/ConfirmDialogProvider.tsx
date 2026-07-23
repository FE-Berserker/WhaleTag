import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from '@mui/material';

/**
 * App-wide MUI confirm dialog — replaces `window.confirm`, which doesn't
 * follow the theme, can't be styled, and blocks the renderer process.
 *
 * Usage:
 *   - Mount `<ConfirmDialogProvider>` near the app root (MainLayout, next to
 *     the other dialog providers).
 *   - From any descendant:
 *       const confirm = useConfirm();
 *       if (await confirm({ message: t('confirmDelete', { name }), danger: true })) { … }
 *
 * One dialog at a time: a second `confirm()` while one is open resolves the
 * first as `false` (matches window.confirm's "only one modal" reality).
 */

export interface ConfirmRequest {
  /** Dialog title. Defaults to the app name-free generic `confirm` key. */
  title?: string;
  /** Body text (already localized by the caller). */
  message: string;
  /** Confirm button label. Defaults to `confirm` ("OK"); pass `delete` etc. */
  confirmLabel?: string;
  /** Red confirm button for destructive actions. */
  danger?: boolean;
}

type ConfirmFn = (req: ConfirmRequest) => Promise<boolean>;

const ConfirmDialogContext = createContext<ConfirmFn | null>(null);

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [req, setReq] = useState<ConfirmRequest | null>(null);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);

  const settle = useCallback((ok: boolean) => {
    resolverRef.current?.(ok);
    resolverRef.current = null;
    setReq(null);
  }, []);

  const confirm = useCallback<ConfirmFn>(
    (next) =>
      new Promise<boolean>((resolve) => {
        // One at a time — a new request auto-cancels the pending one.
        if (resolverRef.current) {
          resolverRef.current(false);
          resolverRef.current = null;
        }
        resolverRef.current = resolve;
        setReq(next);
      }),
    []
  );

  return (
    <ConfirmDialogContext.Provider value={confirm}>
      {children}
      <Dialog
        open={req !== null}
        onClose={() => settle(false)}
        maxWidth="xs"
        fullWidth
      >
        {req?.title ? <DialogTitle>{req.title}</DialogTitle> : null}
        <DialogContent>
          <DialogContentText sx={{ whiteSpace: 'pre-wrap' }}>
            {req?.message}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button color="inherit" onClick={() => settle(false)}>
            {t('cancel')}
          </Button>
          <Button
            variant="contained"
            color={req?.danger ? 'error' : 'primary'}
            autoFocus
            onClick={() => settle(true)}
          >
            {req?.confirmLabel ?? t('confirm')}
          </Button>
        </DialogActions>
      </Dialog>
    </ConfirmDialogContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmDialogContext);
  if (!ctx) {
    throw new Error('useConfirm must be used within a ConfirmDialogProvider');
  }
  return ctx;
}

/**
 * Tolerant variant: returns the MUI dialog when mounted under the provider,
 * otherwise falls back to `window.confirm`. For providers that also get
 * mounted standalone in tests (e.g. IOActionsContextProvider wraps the app
 * in production but is rendered bare in component tests).
 */
export function useConfirmOptional(): ConfirmFn {
  const ctx = useContext(ConfirmDialogContext);
  return useCallback<ConfirmFn>(
    (req) =>
      ctx ? ctx(req) : Promise.resolve(window.confirm(req.message)),
    [ctx]
  );
}
