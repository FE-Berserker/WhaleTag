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

import type {
  SettingsDialogProps,
  SettingsSectionId,
} from './SettingsDialog';

// SettingsDialog is ~1900 lines and pulls WorkflowManagerDialog / AiMcpSection
// / ~25 MUI icons. Lazy-load it so that weight only loads when the user opens
// Settings (the render below is gated on `open`). The type-only import above is
// fully erased, so it does NOT pull the module eagerly.
const SettingsDialog = lazy(() => import('./SettingsDialog'));

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

  const value: SettingsDialogContextValue = {
    openDialog,
    closeDialog,
    isOpen: open,
  };

  return (
    <SettingsDialogContext.Provider value={value}>
      {children}
      {open ? (
        <Suspense fallback={null}>
          <SettingsDialog
            open={open}
            section={requestedSection}
            onClose={closeDialog}
          />
        </Suspense>
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

// Re-export the section id type so consumers can type
// `openDialog({ section: … })` without reaching into SettingsDialog itself.
export type { SettingsSectionId };
export type { SettingsDialogProps };
