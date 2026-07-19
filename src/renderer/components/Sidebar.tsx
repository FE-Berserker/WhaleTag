import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { useDrag, useDrop } from 'react-dnd';
import {
  Box,
  Divider,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
} from '@mui/material';
import CreateNewFolderIcon from '@mui/icons-material/CreateNewFolder';
import FolderIcon from '@mui/icons-material/Folder';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import StarIcon from '@mui/icons-material/Star';
import StarBorderIcon from '@mui/icons-material/StarBorder';
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive';
import NotificationsOffIcon from '@mui/icons-material/NotificationsOff';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import LockOpenOutlinedIcon from '@mui/icons-material/LockOpenOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import RestoreFromTrashIcon from '@mui/icons-material/RestoreFromTrash';
import SettingsIcon from '@mui/icons-material/Settings';
import GestureIcon from '@mui/icons-material/Gesture';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import SmartToyIcon from '@mui/icons-material/SmartToy';

import { RootState } from '-/reducers';
import { COLUMN_HEADER_HEIGHT } from '-/theme';
import {
  removeLocation,
  moveLocation,
  setLocationReadOnly,
} from '-/reducers/locations';
import {
  setDefaultLocation,
  setAiSettings,
  setTaskReminderEnabled,
  setTaskReminderLocationId,
} from '-/reducers/settings';
import { useCurrentLocationContext } from '-/hooks/CurrentLocationContextProvider';
import { useNewExcalidraw } from '-/hooks/useNewExcalidraw';
import { useNewDrawio } from '-/hooks/useNewDrawio';
import { useAiComponent } from '-/hooks/useAiComponent';
import { ipcApi } from '-/services/ipc-api';
import { DND_TYPE_LOCATION, type LocationDragItem } from '-/services/dnd';
import type { WhaleLocation } from '../../shared/ipc-types';
import { useSettingsDialog } from '-/components/SettingsDialogProvider';
import TagGroups from '-/components/TagGroups';
import TagLibrary from '-/components/TagLibrary';

interface SidebarProps {
  onAddLocation: () => void;
  /** Embedded (narrow-window tab mode): drop the title / add-button header
   *  and fill the parent panel (width 100%, no right border) — MainLayout's
   *  tab bar replaces this component's own header. The actions bar is also
   *  skipped: MainLayout renders it once below the tab content so it stays
   *  visible (and uncovered) no matter which tab is active. */
  embedded?: boolean;
}

/**
 * Bottom actions row (trash / AI panel / new excalidraw / new drawio /
 * settings). Lives at the bottom of the Sidebar in wide mode; in narrow
 * (tabbed) mode MainLayout renders it below the tab content instead, so the
 * DirectoryTree tab can't push it off-screen or cover it — that was the
 * "tree occludes the buttons" regression. Exported for MainLayout.
 */
export function SidebarActionsBar() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const aiEnabled = useSelector((s: RootState) => s.settings.aiEnabled);
  const aiPanelOpen = useSelector((s: RootState) => s.settings.aiPanelOpen);
  const newExcalidraw = useNewExcalidraw();
  const newDrawio = useNewDrawio();
  const aiComponent = useAiComponent();
  // Settings dialog is owned one level up by SettingsDialogProvider so other
  // surfaces (file row right-click, kanban card right-click, …) can deep-link
  // to a particular section via `useSettingsDialog().openDialog({ section })`.
  const { openDialog: openSettings } = useSettingsDialog();
  return (
    <Box
      sx={{
        p: 1,
        display: 'flex',
        alignItems: 'center',
        gap: 0.5,
        flexShrink: 0,
      }}
    >
      <Tooltip title={t('openTrash')}>
        <IconButton size="small" onClick={() => void ipcApi.openTrash()}>
          <RestoreFromTrashIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      {aiEnabled ? (
        aiComponent.state.installed ? (
          <Tooltip title={t('aiToggle')}>
            <IconButton
              size="small"
              data-testid="ai-toggle-button"
              color={aiPanelOpen ? 'primary' : 'default'}
              onClick={() =>
                dispatch(setAiSettings({ aiPanelOpen: !aiPanelOpen }))
              }
            >
              <SmartToyIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        ) : (
          <Tooltip title={t('aiComponentNotInstalled')}>
            <span>
              <IconButton size="small" disabled>
                <SmartToyIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        )
      ) : null}
      {newExcalidraw.available && (
        <Tooltip title={t('newExcalidraw')}>
          <span>
            <IconButton
              size="small"
              data-testid="new-excalidraw-button"
              disabled={!newExcalidraw.canCreate}
              onClick={() => {
                newExcalidraw.create().catch(() => undefined);
              }}
            >
              <GestureIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      )}
      {newDrawio.available && (
        <Tooltip title={t('newDrawio')}>
          <span>
            <IconButton
              size="small"
              data-testid="new-drawio-button"
              disabled={!newDrawio.canCreate}
              onClick={() => {
                newDrawio.create().catch(() => undefined);
              }}
            >
              <AccountTreeIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      )}
      <Tooltip title={t('settings')}>
        <IconButton
          size="small"
          data-testid="settings-button"
          onClick={() => {
            openSettings();
          }}
        >
          <SettingsIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Box>
  );
}

/**
 * One location in the list. Draggable up/down to reorder (react-dnd): hovering
 * over a sibling past its midpoint dispatches a live `moveLocation`, so the list
 * reorders under the cursor and the new order persists. A plain click still
 * opens the location (a drag doesn't fire onClick).
 */
function LocationRow({
  loc,
  index,
  selected,
  isDefault,
  isTaskReminder,
  onOpen,
  onContextMenu,
  onRemove,
}: {
  loc: WhaleLocation;
  index: number;
  selected: boolean;
  isDefault: boolean;
  isTaskReminder: boolean;
  onOpen: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onRemove: (e: React.MouseEvent) => void;
}) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const ref = useRef<HTMLDivElement>(null);
  // P?: visible read-only indicator on the row. The previous build only
  // surfaced task-reminder + default indicators; users had no at-a-glance
  // way to see which folders were locked other than right-clicking the row
  // and reading the context-menu label. The closed-lock chip mirrors the
  // same indicator MatrixView's untagged tray uses (see MatrixView.tsx:
  // LockOutlinedIcon for read-only locations), so the visual language is
  // consistent across the surfaces that mention read-only state.
  const isReadOnly = loc.isReadOnly;

  const [, drop] = useDrop<LocationDragItem>({
    accept: DND_TYPE_LOCATION,
    hover(item, monitor) {
      if (!ref.current || item.index === index) return;
      const rect = ref.current.getBoundingClientRect();
      const middleY = (rect.bottom - rect.top) / 2;
      const offset = monitor.getClientOffset();
      if (!offset) return;
      const clientY = offset.y - rect.top;
      // Only cross when the cursor passes the row's midpoint, so reordering
      // doesn't oscillate while hovering the same row.
      if (item.index < index && clientY < middleY) return;
      if (item.index > index && clientY > middleY) return;
      dispatch(moveLocation(item.index, index));
      item.index = index; // track the moved item's new position for next hover
    },
  });

  const [{ isDragging }, drag] = useDrag<
    LocationDragItem,
    unknown,
    { isDragging: boolean }
  >({
    type: DND_TYPE_LOCATION,
    item: { id: loc.id, index },
    collect: (m) => ({ isDragging: m.isDragging() }),
  });

  drag(drop(ref));

  return (
    <ListItemButton
      ref={ref}
      data-loc-row="true"
      selected={selected}
      onClick={onOpen}
      onContextMenu={onContextMenu}
      sx={{
        cursor: 'grab',
        opacity: isDragging ? 0.4 : 1,
        // Suppress MUI ListItemButton's default selected / hover / active / focus
        // background tints — user reports a persistent grey shadow on the
        // selected location row. Current location is signalled by the folder
        // icon + the breadcrumb in the file area instead of a row tint.
        '&.Mui-selected, &.Mui-selected:hover, &:hover, &:active, &:focus, &.Mui-focusVisible':
          { backgroundColor: 'transparent' },
      }}
    >
      <ListItemIcon>
        <FolderIcon />
      </ListItemIcon>
      <ListItemText
        primary={loc.name}
        secondary={loc.path}
        slotProps={{
          primary: { noWrap: true },
          secondary: { noWrap: true, sx: { fontSize: 11 } },
        }}
      />
      {isTaskReminder ? (
        <Tooltip title={t('taskReminder')}>
          <NotificationsActiveIcon
            fontSize="small"
            color="warning"
            sx={{ mr: 0.5, flexShrink: 0 }}
          />
        </Tooltip>
      ) : null}
      {isDefault ? (
        <Tooltip title={t('defaultLocation')}>
          <StarIcon
            fontSize="small"
            color="primary"
            sx={{ mr: 0.5, flexShrink: 0 }}
          />
        </Tooltip>
      ) : null}
      {isReadOnly ? (
        // Color distinct from the warning + primary pair so the three
        // indicators read as a horizontal strip of "what is special about
        // this row": gold star = default, orange bell = task reminder,
        // grey closed lock = read-only.
        <Tooltip title={t('readOnly')}>
          <LockOutlinedIcon
            fontSize="small"
            color="disabled"
            sx={{ mr: 0.5, flexShrink: 0 }}
            data-testid={`sidebar-row-readonly-${loc.id}`}
          />
        </Tooltip>
      ) : null}
      <Tooltip title={t('remove')}>
        <IconButton edge="end" size="small" onClick={onRemove}>
          <DeleteOutlineIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </ListItemButton>
  );
}

/** Left rail: list of configured locations, switch + remove, plus "add". */
export default function Sidebar({ onAddLocation, embedded = false }: SidebarProps) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  // P2-4 (perf audit): select the narrow field, not the whole slice. The
  // whole-slice selectors (`s.locations` / `s.settings`) re-rendered this
  // component on *any* change to those slices — e.g. switching the active
  // location (activeId) re-rendered just to read `items`, and any settings
  // toggle re-rendered just to read `defaultLocationId`.
  const items = useSelector((s: RootState) => s.locations.items);
  const defaultLocationId = useSelector(
    (s: RootState) => s.settings.defaultLocationId
  );
  const taskReminderLocationId = useSelector(
    (s: RootState) => s.settings?.taskReminderLocationId ?? null
  );
  const { currentLocation, openLocation } = useCurrentLocationContext();
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    locId: string;
  } | null>(null);
  // Right-click on the empty area of the locations list (no locations yet, or
  // the blank space below the last one) — surfaces an "Add Location" action so
  // the affordance is discoverable without having to reach for the header +.
  const [emptyCtxMenu, setEmptyCtxMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  // Root container ref — used by the document-level contextmenu listener to
  // decide whether a right-click landed inside the sidebar (where the row /
  // empty-area `onContextMenu` handlers take over) or outside (where we need
  // to dismiss any open menu).
  const rootRef = useRef<HTMLDivElement | null>(null);

  // MUI <Menu> with anchorReference="anchorPosition" + a non-focusable Box
  // trigger loses its built-in click-away: focus never leaves the trigger, so
  // the internal focusout-based close never fires. Add a document-level
  // mousedown so a left-click anywhere outside the menu paper always closes it.
  useEffect(() => {
    if (emptyCtxMenu === null) return;
    const handleMouseDown = (e: MouseEvent) => {
      // Right-click is handled by onContextMenu (it re-opens / re-positions the
      // menu), middle-click is rare; only respond to left-click.
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest('[role="menu"]')) return;
      setEmptyCtxMenu(null);
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [emptyCtxMenu]);

  // Right-click outside the sidebar (e.g. on the file list / directory tree /
  // app bar) used to leave both the per-location and empty-area menus stuck
  // open, because MUI's built-in close only fires on left-click (backdrop) and
  // Escape. Mirror the mousedown handler with a contextmenu listener that
  // closes both menus when the right-click lands outside the sidebar root and
  // outside the menu paper itself.
  useEffect(() => {
    if (ctxMenu === null && emptyCtxMenu === null) return;
    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[role="menu"]')) return;
      if (rootRef.current && rootRef.current.contains(target)) return;
      setCtxMenu(null);
      setEmptyCtxMenu(null);
    };
    document.addEventListener('contextmenu', handleContextMenu);
    return () => document.removeEventListener('contextmenu', handleContextMenu);
  }, [ctxMenu, emptyCtxMenu]);

  const handleRemove = (id: string, name: string) => {
    if (window.confirm(t('confirmRemoveLocation', { name }))) {
      dispatch(removeLocation(id));
    }
  };

  return (
    <Box
      ref={rootRef}
      sx={{
        width: embedded ? '100%' : 260,
        flexShrink: 0,
        borderRight: embedded ? 0 : 1,
        borderColor: 'divider',
        display: 'flex',
        flexDirection: 'column',
        ...(embedded ? { height: '100%' } : {}),
      }}
    >
      {embedded ? null : (
        <Box
          sx={{
            minHeight: COLUMN_HEADER_HEIGHT,
            px: 1.5,
            py: 0,
            flexShrink: 0,
            borderBottom: 1,
            borderColor: 'divider',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Typography variant="overline" color="text.secondary">
            {t('locations')}
          </Typography>
          <Tooltip title={t('addLocation')}>
            <IconButton size="small" onClick={onAddLocation}>
              <CreateNewFolderIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      )}
      <Box
        sx={{ flex: 1, minHeight: 160, overflowY: 'auto' }}
        onContextMenu={(e) => {
          // Only react to right-clicks that land on the empty area itself, not
          // on a location row (rows have their own context menu).
          if ((e.target as HTMLElement).closest('[data-loc-row]')) return;
          e.preventDefault();
          setCtxMenu(null); // close the per-location menu if open
          setEmptyCtxMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {items.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
            {t('noLocationsHint')}
          </Typography>
        ) : (
          <List dense>
            {items.map((loc, index) => (
              <LocationRow
                key={loc.id}
                loc={loc}
                index={index}
                selected={loc.id === currentLocation?.id}
                isDefault={loc.id === defaultLocationId}
                isTaskReminder={loc.id === taskReminderLocationId}
                onOpen={() => openLocation(loc)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setEmptyCtxMenu(null); // close the empty-area menu if open
                  setCtxMenu({ x: e.clientX, y: e.clientY, locId: loc.id });
                }}
                onRemove={(e) => {
                  e.stopPropagation();
                  handleRemove(loc.id, loc.name);
                }}
              />
            ))}
          </List>
        )}
      </Box>
      <TagGroups />
      <TagLibrary />
      {embedded ? null : (
        <>
          <Divider />
          <SidebarActionsBar />
        </>
      )}

      <Menu
        open={ctxMenu !== null}
        onClose={() => setCtxMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={
          ctxMenu ? { top: ctxMenu.y, left: ctxMenu.x } : undefined
        }
        slotProps={{ paper: { sx: { minWidth: 200 } } }}
      >
        {(() => {
          if (!ctxMenu) return null;
          const loc = items.find((l) => l.id === ctxMenu.locId);
          if (!loc) return null;
          return (
            <>
              <MenuItem
                onClick={() => {
                  openLocation(loc);
                  setCtxMenu(null);
                }}
              >
                <ListItemIcon>
                  <FolderOpenIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>{t('open')}</ListItemText>
              </MenuItem>
              <MenuItem
                onClick={() => {
                  void ipcApi.revealPath(loc.path).catch(() => undefined);
                  setCtxMenu(null);
                }}
              >
                <ListItemIcon>
                  <OpenInNewIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>{t('revealInExplorer')}</ListItemText>
              </MenuItem>
              {/* Default location pair (set / clear). Each icon mirrors the
                  on/off state — solid gold star when this location IS the
                  default, outline star when it isn't yet. Reversible by the
                  second entry. */}
              {(() => {
                const isThisDefault =
                  defaultLocationId === loc.id;
                if (isThisDefault) {
                  return (
                    <MenuItem
                      data-testid={`sidebar-clear-default-${loc.id}`}
                      onClick={() => {
                        dispatch(setDefaultLocation(null));
                        setCtxMenu(null);
                      }}
                    >
                      <ListItemIcon>
                        <StarIcon fontSize="small" color="primary" />
                      </ListItemIcon>
                      <ListItemText>
                        {t('clearDefaultLocation')}
                      </ListItemText>
                    </MenuItem>
                  );
                }
                return (
                  <MenuItem
                    data-testid={`sidebar-set-default-${loc.id}`}
                    onClick={() => {
                      dispatch(setDefaultLocation(loc.id));
                      setCtxMenu(null);
                    }}
                  >
                    <ListItemIcon>
                      <StarBorderIcon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText>{t('setAsDefault')}</ListItemText>
                  </MenuItem>
                );
              })()}
              <Divider />
              {/* UX shortcut (H.x P?): toggle the location's readOnly
                  flag in place. Previously only settable via re-adding
                  the location through AddLocationDialog, which is awkward
                  when the user just wants to lock down a folder. Icon
                  mirrors the on/off state — open lock when the folder is
                  writable, closed lock when it's read-only. */}
              <MenuItem
                data-testid={`sidebar-toggle-readonly-${loc.id}`}
                onClick={() => {
                  dispatch(setLocationReadOnly(loc.id, !loc.isReadOnly));
                  setCtxMenu(null);
                }}
              >
                <ListItemIcon>
                  {loc.isReadOnly ? (
                    <LockOutlinedIcon fontSize="small" color="primary" />
                  ) : (
                    <LockOpenOutlinedIcon fontSize="small" />
                  )}
                </ListItemIcon>
                <ListItemText>
                  {loc.isReadOnly ? t('setReadOnlyOff') : t('setReadOnlyOn')}
                </ListItemText>
              </MenuItem>
              <Divider />
              {/* UX shortcut: set this location as the task-reminder
                  folder (writes `settings.taskReminderLocationId` and
                  turns `settings.taskReminderEnabled` on). Previously
                  reachable only via Settings → Notifications; the same
                  action on the same location a second time clears the
                  binding, so the menu is reversible. Icon mirrors the
                  on/off state — on-bell when active, off-bell when
                  removable. */}
              {(() => {
                const isThisReminder =
                  taskReminderLocationId === loc.id;
                return (
                  <MenuItem
                    data-testid={`sidebar-task-reminder-${loc.id}`}
                    onClick={() => {
                      if (isThisReminder) {
                        dispatch(setTaskReminderLocationId(null));
                        dispatch(setTaskReminderEnabled(false));
                      } else {
                        dispatch(setTaskReminderLocationId(loc.id));
                        dispatch(setTaskReminderEnabled(true));
                      }
                      setCtxMenu(null);
                    }}
                  >
                    <ListItemIcon>
                      {isThisReminder ? (
                        <NotificationsActiveIcon
                          fontSize="small"
                          color="primary"
                        />
                      ) : (
                        <NotificationsOffIcon fontSize="small" />
                      )}
                    </ListItemIcon>
                    <ListItemText>
                      {isThisReminder
                        ? t('clearTaskReminderLocation')
                        : t('setTaskReminderLocation')}
                    </ListItemText>
                  </MenuItem>
                );
              })()}
              <Divider />
              <MenuItem
                onClick={() => {
                  handleRemove(loc.id, loc.name);
                  setCtxMenu(null);
                }}
              >
                <ListItemIcon>
                  <DeleteOutlineIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>{t('remove')}</ListItemText>
              </MenuItem>
            </>
          );
        })()}
      </Menu>

      <Menu
        open={emptyCtxMenu !== null}
        onClose={() => setEmptyCtxMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={
          emptyCtxMenu
            ? { top: emptyCtxMenu.y, left: emptyCtxMenu.x }
            : undefined
        }
        slotProps={{ paper: { sx: { minWidth: 180 } } }}
      >
        <MenuItem
          onClick={() => {
            setEmptyCtxMenu(null);
            onAddLocation();
          }}
        >
          <ListItemIcon>
            <CreateNewFolderIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t('addLocation')}</ListItemText>
        </MenuItem>
      </Menu>
    </Box>
  );
}
