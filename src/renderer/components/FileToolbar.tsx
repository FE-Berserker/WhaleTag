import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import {
  Alert,
  Box,
  Button,
  Divider,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Slider,
  Snackbar,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import RefreshIcon from '@mui/icons-material/Refresh';
import CreateNewFolderIcon from '@mui/icons-material/CreateNewFolder';
import NoteAddIcon from '@mui/icons-material/NoteAdd';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import HistoryIcon from '@mui/icons-material/History';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';

import { RootState } from '-/reducers';
import { EMPTY_ARR } from '-/constants';
import { COLUMN_HEADER_HEIGHT } from '-/theme';
import { clearRecent } from '-/reducers/recent';
import { setViewDepth, MAX_VIEW_DEPTH, MIN_VIEW_DEPTH } from '-/reducers/settings';
import { useCurrentLocationContext } from '-/hooks/CurrentLocationContextProvider';
import { useDirectoryContentContext } from '-/hooks/DirectoryContentContextProvider';
import { useIOActionsContext } from '-/hooks/IOActionsContextProvider';
import { basename } from '-/services/path-util';
import PromptDialog from '-/components/PromptDialog';
import SearchBar from '-/components/SearchBar';
import BreadcrumbNav from '-/components/BreadcrumbNav';
import ThemeQuickToggle from '-/components/ThemeQuickToggle';

type CreateKind = 'folder' | 'file';

/**
 * Breakpoints for the FileToolbar responsive fold. Below each threshold the
 * named cluster is moved into the `⋮` overflow menu so the toolbar never
 * overflows its workspace column (and gets visually clipped under the
 * AiPanel on the right).
 *
 * The numbers are chosen against the natural content width of each cluster
 * (label + icon + slider for viewDepth; icon + label for new-folder/new-file),
 * plus 8px flex `gap` and a safety margin so a half-step resize doesn't
 * flicker. They were picked empirically against the default `aiPanelWidth=420`
 * (Sidebar 260 + DirectoryTree 240 + AiPanel 420 = 920px fixed) — at a 1024px
 * window that leaves ~104px for the workspace, and 720 / 560 give the
 * Breadcrumb / SearchBar room to coexist with the new-folder / new-file
 * actions before folding kicks in.
 *
 * Exported so `FileToolbar.test.ts` can lock the threshold values down and
 * future tweaks don't drift unintentionally.
 */
export const FOLD_VIEW_DEPTH_BELOW = 720;
export const FOLD_CREATE_BUTTONS_BELOW = 560;

/**
 * Pure derivation of which FileToolbar clusters are visible at a given
 * workspace width. Extracted from the component so the threshold rules are
 * unit-testable without standing up the full provider stack.
 *
 * `Infinity` (the pre-ResizeObserver initial value) counts as "wide", so the
 * first paint shows everything and we never flash a folded toolbar on cold
 * render.
 */
export function computeFileToolbarVisibility(width: number): {
  showViewDepth: boolean;
  showCreateButtons: boolean;
  showMoreMenu: boolean;
} {
  const showViewDepth = width >= FOLD_VIEW_DEPTH_BELOW;
  const showCreateButtons = width >= FOLD_CREATE_BUTTONS_BELOW;
  return {
    showViewDepth,
    showCreateButtons,
    showMoreMenu: !showViewDepth || !showCreateButtons,
  };
}

/** Toolbar above the file list: up / refresh / new folder / new file + path. */
export default function FileToolbar() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const {
    currentDirectoryPath,
    currentLocation,
    navigateToInLocation,
    goUp,
    goBack,
    goForward,
    canGoBack,
    canGoForward,
  } = useCurrentLocationContext();
  const { refresh, loading } = useDirectoryContentContext();
  const { createFolder, createFile } = useIOActionsContext();
  const recentItems = useSelector(
    (s: RootState) => s.recent?.items ?? EMPTY_ARR
  );
  const locations = useSelector((s: RootState) => s.locations.items);
  // H.24: viewDepth is the global recursion depth for the file area. Until
  // the data-layer change in PR3 ships, this slider only updates settings —
  // it has no observable effect on the entry list yet. That's intentional:
  // PR1 keeps the surface area small, and the field is already wired into
  // the reducer + migration so a future release can flip the switch.
  const viewDepth = useSelector(
    (s: RootState) => s.settings?.viewDepth ?? 1
  );

  const [dialog, setDialog] = useState<CreateKind | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recentAnchor, setRecentAnchor] = useState<HTMLElement | null>(null);
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);

  // Track the FileToolbar's content width so we can fold non-essential
  // clusters (viewDepth slider, new folder/file buttons) into the `⋮`
  // overflow menu when the workspace column gets narrow — typically when
  // the AiPanel is open and the window is small. Without this the toolbar
  // would overflow the column's right edge and the ThemeQuickToggle
  // (rightmost child) would be visually clipped under the AiPanel's
  // overlay paint order. We start at Infinity so the first paint shows
  // everything, avoiding a flash of folded items on cold render.
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [toolbarWidth, setToolbarWidth] = useState<number>(Infinity);
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // P3-5 (perf audit): guard against spurious same-width RO notifications
        // (matches FileList's pattern) so resize ticks don't re-render the bar.
        setToolbarWidth((prev) => {
          const w = entry.contentRect.width;
          return prev === w ? prev : w;
        });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { showViewDepth, showCreateButtons, showMoreMenu } =
    computeFileToolbarVisibility(toolbarWidth);

  // Only show recents whose location still exists; tag each with its name.
  // P3-5 (perf audit): memoize — this maps + filters on every render otherwise,
  // handing consumers a fresh array each time.
  const recents = useMemo(
    () =>
      recentItems
        .map((it) => ({
          ...it,
          location: locations.find((l) => l.id === it.locationId),
        }))
        .filter(
          (it): it is typeof it & { location: NonNullable<typeof it.location> } =>
            it.location !== undefined
        ),
    [recentItems, locations]
  );

  const atRoot =
    !!currentLocation && currentDirectoryPath === currentLocation.path;

  const handleConfirm = async (name: string) => {
    const kind = dialog;
    setDialog(null);
    try {
      if (kind === 'folder') await createFolder(name);
      else if (kind === 'file') await createFile(name);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Box
      ref={toolbarRef}
      sx={{
        minHeight: COLUMN_HEADER_HEIGHT,
        px: 1.5,
        py: 0,
        flexShrink: 0,
        borderBottom: 1,
        borderColor: 'divider',
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        // H.17 P?: clip horizontal overflow at the toolbar's own right
        // edge so a narrow workspace column + AiPanel can't visually
        // overlap our rightmost children (ThemeQuickToggle). The `⋮`
        // menu + responsive folding above ensure the always-visible
        // cluster fits; overflow:hidden here is the safety net.
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <Tooltip title={t('up')}>
        <span>
          <IconButton size="small" onClick={() => goUp()} disabled={atRoot}>
            <ArrowUpwardIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title={t('back')}>
        <span>
          <IconButton size="small" onClick={goBack} disabled={!canGoBack}>
            <ArrowBackIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title={t('forward')}>
        <span>
          <IconButton
            size="small"
            onClick={goForward}
            disabled={!canGoForward}
          >
            <ArrowForwardIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title={t('recent')}>
        <span>
          <IconButton
            size="small"
            onClick={(e) => setRecentAnchor(e.currentTarget)}
            disabled={recents.length === 0}
          >
            <HistoryIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Menu
        anchorEl={recentAnchor}
        open={recentAnchor !== null}
        onClose={() => setRecentAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { sx: { maxWidth: 360 } } }}
      >
        {recents.map((it) => {
          const isRoot = it.path === it.location.path;
          const label = isRoot ? it.location.name : basename(it.path);
          return (
            <MenuItem
              key={`${it.locationId}:${it.path}`}
              onClick={() => {
                setRecentAnchor(null);
                navigateToInLocation(it.locationId, it.path);
              }}
            >
              <ListItemText
                primary={label}
                secondary={it.path}
                slotProps={{
                  primary: { noWrap: true },
                  secondary: { noWrap: true, sx: { fontSize: 11 } },
                }}
              />
            </MenuItem>
          );
        })}
        <Divider />
        <MenuItem
          onClick={() => {
            setRecentAnchor(null);
            dispatch(clearRecent());
          }}
        >
          {t('clearRecent')}
        </MenuItem>
      </Menu>
      <Tooltip title={t('refresh')}>
        <IconButton size="small" onClick={() => refresh()}>
          <RefreshIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      {showCreateButtons ? (
        <>
          <Button
            size="small"
            startIcon={<CreateNewFolderIcon />}
            onClick={() => setDialog('folder')}
            disabled={!!currentLocation?.isReadOnly}
            sx={{ whiteSpace: 'nowrap', flexShrink: 0, minWidth: 'auto' }}
          >
            {t('newFolder')}
          </Button>
          <Button
            size="small"
            startIcon={<NoteAddIcon />}
            onClick={() => setDialog('file')}
            disabled={!!currentLocation?.isReadOnly}
            sx={{ whiteSpace: 'nowrap', flexShrink: 0, minWidth: 'auto' }}
          >
            {t('newFile')}
          </Button>
        </>
      ) : null}
      <SearchBar />
      {showViewDepth ? (
        <Tooltip title={t('viewDepthHint')}>
          <Stack
            direction="row"
            spacing={1.25}
            sx={{
              alignItems: 'center',
              flexShrink: 0,
              opacity: loading ? 0.5 : 1,
            }}
          >
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ whiteSpace: 'nowrap', fontWeight: 500 }}
            >
              {t('viewDepth')}
            </Typography>
            <Slider
              size="small"
              value={viewDepth}
              min={MIN_VIEW_DEPTH}
              max={MAX_VIEW_DEPTH}
              step={1}
              valueLabelDisplay="auto"
              valueLabelFormat={(v) => `${v}`}
              onChange={(_e, value) => {
                const next = Array.isArray(value) ? value[0] : value;
                dispatch(setViewDepth(next));
              }}
              disabled={loading}
              sx={{ width: 70 }}
            />
          </Stack>
        </Tooltip>
      ) : null}
      <Box sx={{ flex: 1, minWidth: 16 }} />
      <BreadcrumbNav />
      {/*
        Right-edge cluster: ThemeQuickToggle is a fixed-size icon button
        (~40px), and the `⋮` button is the overflow menu for the folded
        clusters. Both live inside a `flexShrink: 0` wrapper so the spacer
        above + the BreadcrumbNav's flex:1 absorb the slack first — these
        are the LAST things to be squeezed (and the ThemeQuickToggle never
        gets clipped, since we never hide it).
      */}
      <Box
        sx={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 0.25,
        }}
      >
        <ThemeQuickToggle />
        {showMoreMenu ? (
          <Tooltip title={t('more')}>
            <IconButton
              size="small"
              data-testid="file-toolbar-more"
              onClick={(e) => setMoreAnchor(e.currentTarget)}
            >
              <MoreHorizIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        ) : null}
      </Box>
      <Menu
        anchorEl={moreAnchor}
        open={moreAnchor !== null}
        onClose={() => setMoreAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { minWidth: 220 } } }}
      >
        {!showCreateButtons ? (
          <>
            <MenuItem
              disabled={!!currentLocation?.isReadOnly}
              data-testid="file-toolbar-more-new-folder"
              onClick={() => {
                setMoreAnchor(null);
                setDialog('folder');
              }}
            >
              <ListItemIcon>
                <CreateNewFolderIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{t('newFolder')}</ListItemText>
            </MenuItem>
            <MenuItem
              disabled={!!currentLocation?.isReadOnly}
              data-testid="file-toolbar-more-new-file"
              onClick={() => {
                setMoreAnchor(null);
                setDialog('file');
              }}
            >
              <ListItemIcon>
                <NoteAddIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{t('newFile')}</ListItemText>
            </MenuItem>
          </>
        ) : null}
        {!showViewDepth ? (
          // The slider is wrapped in a non-MenuItem Box so dragging the
          // thumb doesn't fire MenuItem.onClick (which would close the
          // menu mid-drag). MUI Menu only auto-closes on MenuItem clicks
          // and on backdrop / Escape; a plain Box inside the menu is
          // inert to that.
          <Box
            data-testid="file-toolbar-more-viewdepth"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            sx={{ px: 2, py: 1.5 }}
          >
            <Stack
              direction="row"
              spacing={1.25}
              sx={{ alignItems: 'center' }}
            >
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ whiteSpace: 'nowrap', fontWeight: 500 }}
              >
                {t('viewDepth')}
              </Typography>
              <Slider
                size="small"
                value={viewDepth}
                min={MIN_VIEW_DEPTH}
                max={MAX_VIEW_DEPTH}
                step={1}
                valueLabelDisplay="auto"
                valueLabelFormat={(v) => `${v}`}
                onChange={(_e, value) => {
                  const next = Array.isArray(value) ? value[0] : value;
                  dispatch(setViewDepth(next));
                }}
                disabled={loading}
                sx={{ width: 100 }}
              />
            </Stack>
          </Box>
        ) : null}
      </Menu>

      <PromptDialog
        open={dialog !== null}
        title={dialog === 'folder' ? t('newFolder') : t('newFile')}
        label={t('name')}
        onConfirm={handleConfirm}
        onClose={() => setDialog(null)}
      />

      <Snackbar
        open={notice !== null}
        autoHideDuration={6000}
        onClose={() => setNotice(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity="error"
          variant="filled"
          onClose={() => setNotice(null)}
        >
          {notice}
        </Alert>
      </Snackbar>
    </Box>
  );
}
