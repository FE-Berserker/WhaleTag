import { useEffect, useState } from 'react';
import { Box, IconButton, Tooltip, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import CropSquareIcon from '@mui/icons-material/CropSquare';
import FilterNoneIcon from '@mui/icons-material/FilterNone';
import RemoveIcon from '@mui/icons-material/Remove';

import LogoIcon from '-/assets/LogoIcon';
import { ipcApi } from '-/services/ipc-api';

/**
 * Frameless dark title bar — replaces the native Windows title bar + white menu
 * bar. The whole bar is draggable (`-webkit-app-region: drag`); the window
 * buttons on the right opt out (`no-drag`) so clicks reach them. Logo + app
 * name on the left; minimize / maximize-toggle / close on the right.
 */
export default function TitleBar(): JSX.Element {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    // Sync initial state, then subscribe to main-process maximize/unmaximize so
    // the toggle button's icon tracks the real window state.
    ipcApi.windowIsMaximized().then(setMaximized);
    const unsubscribe = ipcApi.onWindowMaximizeChange(setMaximized);
    return unsubscribe;
  }, []);

  return (
    <Box
      sx={{
        height: 32,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1,
        bgcolor: 'background.default',
        borderBottom: 1,
        borderColor: 'divider',
        WebkitAppRegion: 'drag',
        userSelect: 'none',
      }}
    >
      <LogoIcon sx={{ width: 18, height: 18 }} />
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        WhaleTag
      </Typography>
      <Box sx={{ flex: 1 }} />
      <Box sx={{ display: 'flex', WebkitAppRegion: 'no-drag' }}>
        <Tooltip title="最小化" enterDelay={500}>
          <IconButton size="small" onClick={() => void ipcApi.windowMinimize()}>
            <RemoveIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={maximized ? '还原' : '最大化'} enterDelay={500}>
          <IconButton
            size="small"
            onClick={() => void ipcApi.windowMaximizeToggle()}
          >
            {maximized ? (
              <FilterNoneIcon fontSize="small" />
            ) : (
              <CropSquareIcon fontSize="small" />
            )}
          </IconButton>
        </Tooltip>
        <Tooltip title="关闭" enterDelay={500}>
          <IconButton
            size="small"
            onClick={() => void ipcApi.windowClose()}
            sx={{
              '&:hover': { bgcolor: 'rgba(232,17,35,0.9)', color: '#fff' },
            }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
}
