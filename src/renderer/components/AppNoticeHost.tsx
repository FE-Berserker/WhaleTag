import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Snackbar from '@mui/material/Snackbar';

import {
  AppNotice,
  subscribeAppNotices,
} from '-/services/app-notice';

/**
 * Renders notices pushed through `notifyApp` (see `-/services/app-notice`).
 * Mounted once in `Root.tsx`, inside the theme but outside the view tree so a
 * failed sidebar/background action is visible regardless of which view is
 * active. Views with their own snackbar keep using it — this is the fallback
 * surface, not a second copy of every toast.
 */
export default function AppNoticeHost(): JSX.Element {
  const [notice, setNotice] = useState<AppNotice | null>(null);

  useEffect(() => subscribeAppNotices(setNotice), []);

  return (
    <Snackbar
      open={notice !== null}
      autoHideDuration={notice?.severity === 'error' ? 8000 : 5000}
      onClose={() => setNotice(null)}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
    >
      {/* Snackbar keeps its child mounted while closed, so reads stay
          null-safe even when `open` is false. */}
      <Alert
        severity={notice?.severity ?? 'info'}
        variant="filled"
        onClose={() => setNotice(null)}
      >
        {notice?.message ?? ''}
      </Alert>
    </Snackbar>
  );
}
