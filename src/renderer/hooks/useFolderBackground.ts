import { useCallback, useEffect, useState } from 'react';

import { ipcApi } from '-/services/ipc-api';

export interface FolderBackgroundState {
  /** Data URL for the current directory's `.whale/wsb.jpg`, or null. */
  backgroundUrl: string | null;
  /** Re-read after a set/clear operation. Stable across renders. */
  reloadFolderBackground: () => void;
}

/**
 * Loads the decorative background for the current directory.
 *
 * The old image is cleared immediately on navigation/reload, and the effect's
 * generation is invalidated on cleanup so a slow response for the previous
 * directory can never paint over the new one. Backgrounds are optional UI:
 * a missing file or a failed read simply falls back to the normal theme.
 */
export function useFolderBackground(dirPath: string): FolderBackgroundState {
  const [background, setBackground] = useState<{
    dirPath: string;
    url: string | null;
  }>({ dirPath: '', url: null });
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    setBackground({ dirPath, url: null });
    if (dirPath) {
      ipcApi
        .loadFolderBackground(dirPath)
        .then((url) => {
          if (active) setBackground({ dirPath, url });
        })
        .catch(() => {
          if (active) setBackground({ dirPath, url: null });
        });
    }
    return () => {
      active = false;
    };
  }, [dirPath, revision]);

  const reloadFolderBackground = useCallback(() => {
    setRevision((value) => value + 1);
  }, []);

  return {
    // Key the image by directory so navigation cannot paint the old image for
    // the commit before the next effect runs.
    backgroundUrl: background.dirPath === dirPath ? background.url : null,
    reloadFolderBackground,
  };
}
