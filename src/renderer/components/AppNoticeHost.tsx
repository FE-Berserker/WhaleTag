import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';

import {
  AppNotice,
  enqueueNotice,
  subscribeAppNotices,
} from '-/services/app-notice';

/**
 * Auto-hide per severity. Every queued notice gets this full duration because
 * the Snackbar is keyed by notice id (see below), which remounts it.
 */
function autoHideDurationFor(notice: AppNotice | null): number | null {
  if (notice === null) return null;
  return notice.severity === 'error' ? 8000 : 5000;
}

/**
 * Renders notices pushed through `notifyApp` (see `-/services/app-notice`).
 * Mounted once in `Root.tsx`, inside the theme but outside the view tree so a
 * failed sidebar/background action is visible regardless of which view is
 * active. Views with their own snackbar keep using it — this is the fallback
 * surface, not a second copy of every toast.
 */
export default function AppNoticeHost(): JSX.Element {
  // A queue, not a single slot: two failures in the same tick used to overwrite
  // each other, so the first message was never readable. The head is on screen
  // and the rest wait their turn (bounded by MAX_NOTICE_QUEUE).
  const [queue, setQueue] = useState<AppNotice[]>([]);
  const notice = queue[0] ?? null;

  useEffect(
    () =>
      subscribeAppNotices((next) =>
        setQueue((current) => enqueueNotice(current, next))
      ),
    []
  );

  const dismiss = () => setQueue((current) => current.slice(1));

  return (
    <Snackbar
      // Keying by notice id remounts the Snackbar for every queued notice, so
      // the auto-hide timer restarts from zero. `useSnackbar` only re-arms its
      // timer when `open`/`autoHideDuration` change; with a stable slot, a
      // second error arriving during the first toast inherited the remaining
      // time and could vanish almost immediately.
      key={notice?.id ?? 'empty'}
      open={notice !== null}
      autoHideDuration={autoHideDurationFor(notice)}
      onClose={dismiss}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
    >
      {/* Snackbar keeps its child mounted while closed, so reads stay
          null-safe even when `open` is false. */}
      <Alert
        severity={notice?.severity ?? 'info'}
        variant="filled"
        onClose={dismiss}
      >
        {notice?.message ?? ''}
      </Alert>
    </Snackbar>
  );
}
