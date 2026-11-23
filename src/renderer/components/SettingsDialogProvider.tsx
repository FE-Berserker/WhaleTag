/**
 * Lifts `<SettingsDialog>` ownership one level above the Sidebar so any
 * renderer component (notably the file row / kanban card / agenda entry
 * context menus) can ask the user to be sent straight to a particular
 * settings tab — e.g. right-click → "Task reminder…" pops open the dialog
 * pre-focused on the `notifications` section (where the existing task
 * reminder controls live, see SettingsDialog.tsx). This replaces the
 * pre-existing Sidebar-only `settingsOpen` / `settingsSection` state so the
 * dialog is no longer tied to Sidebar's render lifetime.
 *
 * Usage:
 *   - Mount `<SettingsDialogProvider>` near the app root (MainLayout).
 *   - From any descendant: `const { openDialog, closeDialog } = useSettingsDialog();`
 *     then `openDialog({ section: 'notifications' })`.
 *
 * The dialog itself is unchanged — it still owns the section it shows based
 * on the `section` prop at the moment `open` flips to true (see SettingsDialog's
 * `useEffect(open)`), so re-opening after closing always lands the user on
 * the section the caller requested.
 */

import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
} from '@mui/material';

import type {
  SettingsDialogProps,
  SettingsSectionId,
} from './SettingsDialog';
import ErrorBoundary from './ErrorBoundary';

// SettingsDialog is ~1900 lines and pulls WorkflowManagerDialog / AiMcpSection
// / ~25 MUI icons. Lazy-load it so that weight only loads when the user opens
// Settings (the render below is gated on `open`). The type-only import above is
// fully erased, so it does NOT pull the module eagerly.
const loadSettingsDialog = () => import('./SettingsDialog');

interface OpenSettingsArgs {
  /** When set, focus this tab on the next open. Falls back to `general`. */
  section?: SettingsSectionId;
}

interface SettingsDialogContextValue {
  /**
   * Open the settings dialog. Pass `{ section }` to deep-link to a tab —
   * e.g. the file context menu's "Task reminder…" entry uses `section:
   * 'notifications'` since that's where the reminder controls already live.
   */
  openDialog: (args?: OpenSettingsArgs) => void;
  closeDialog: () => void;
  /** Current open state — readable (not required) by surrounding UI. */
  isOpen: boolean;
}

const SettingsDialogContext = createContext<SettingsDialogContextValue | null>(
  null
);

/**
 * Provider that owns the dialog's open + last-requested-section state.
 * Mount once near the app root (MainLayout). The dialog is rendered as a
 * child so it lives at z-index top — same as the Sidebar-local render it
 * replaces.
 */
export function SettingsDialogProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [requestedSection, setRequestedSection] =
    useState<SettingsSectionId | undefined>(undefined);
  // A rejected lazy() is cached forever, so a failed chunk load needs a fresh
  // lazy component on retry. This counter is a cache-buster, not render state.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [SettingsDialog, setSettingsDialog] = useState(() =>
    lazy(loadSettingsDialog)
  );

  const handleRetry = useCallback(() => {
    setLoadAttempt((attempt) => attempt + 1);
    setSettingsDialog(() => lazy(loadSettingsDialog));
  }, []);

  const openDialog = useCallback((args?: OpenSettingsArgs) => {
    setRequestedSection(args?.section);
    setOpen(true);
  }, []);

  const closeDialog = useCallback(() => {
    setOpen(false);
  }, []);

  // Reset `requestedSection` to undefined once the dialog has been closed so
  // the next open (without an explicit section argument) uses whatever the
  // dialog itself settles on — the dialog already picks up `section` via
  // its own useEffect on `open` flip. Leaving the previous section would
  // re-open on the last-deep-linked tab when the user just clicks the
  // Sidebar's gear icon.
  useEffect(() => {
    if (!open) setRequestedSection(undefined);
  }, [open]);

  // Global Ctrl+, / Cmd+, toggles Settings (VS Code convention). Lives here
  // (not in the list/grid keybindings map, which is modifier-free by design)
  // so it works from every perspective. Key events inside an extension
  // iframe stay in the iframe — editing won't accidentally pop Settings.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return; // hold Ctrl+, must not flap the dialog
      if (e.key === ',' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const value: SettingsDialogContextValue = {
    openDialog,
    closeDialog,
    isOpen: open,
  };

  return (
    <SettingsDialogContext.Provider value={value}>
      {children}
      {open ? (
        <ErrorBoundary
          resetKey={loadAttempt}
          fallback={
            <SettingsLoadFailedDialog
              onClose={closeDialog}
              onRetry={handleRetry}
            />
          }
        >
          <Suspense fallback={<SettingsLoadingDialog />}>
            <SettingsDialog
              open={open}
              section={requestedSection}
              onClose={closeDialog}
            />
          </Suspense>
        </ErrorBoundary>
      ) : null}
    </SettingsDialogContext.Provider>
  );
}

export function useSettingsDialog(): SettingsDialogContextValue {
  const ctx = useContext(SettingsDialogContext);
  if (!ctx) {
    throw new Error(
      'useSettingsDialog must be used within a SettingsDialogProvider'
    );
  }
  return ctx;
}

/** Non-null Suspense fallback: clicking the gear must never look like a no-op. */
function SettingsLoadingDialog() {
  const { t } = useTranslation();
  return (
    <Dialog open maxWidth="xs" fullWidth>
      <DialogTitle>{t('settings')}</DialogTitle>
      <DialogContent>
        <LinearProgress />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Shown when the settings chunk (or the dialog render) fails. Retry creates a
 * fresh lazy component because React caches a rejected import permanently;
 * Close leaves the app usable instead of replacing the whole window.
 */
function SettingsLoadFailedDialog({
  onClose,
  onRetry,
}: {
  onClose: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{t('settings')}</DialogTitle>
      <DialogContent>
        <Alert severity="error">{t('errorOccurred')}</Alert>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('close')}</Button>
        <Button variant="contained" onClick={onRetry}>
          {t('retry')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// Re-export the section id type so consumers can type
// `openDialog({ section: … })` without reaching into SettingsDialog itself.
export type { SettingsSectionId };
export type { SettingsDialogProps };
