import {
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
} from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import EditIcon from '@mui/icons-material/Edit';
import LocationOffIcon from '@mui/icons-material/LocationOff';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import SaveIcon from '@mui/icons-material/Save';
import DriveFileMoveIcon from '@mui/icons-material/DriveFileMove';
import PhotoLibraryIcon from '@mui/icons-material/PhotoLibrary';
import AddLocationIcon from '@mui/icons-material/AddLocation';

import type { TFunction } from 'i18next';
import type { DirEntry } from '../../shared/ipc-types';
import { NoBackdrop, NoTransition } from './MenuNoTransition';

export interface MapiqueContext {
  x: number;
  y: number;
  type: 'marker' | 'tray' | 'blank';
  entry?: DirEntry;
  lat?: number;
  lng?: number;
}

export interface MapiqueContextMenuProps {
  ctx: MapiqueContext | null;
  onClose: () => void;
  t: TFunction;
  onOpen?: (entry: DirEntry) => void;
  onReveal?: (entry: DirEntry) => void;
  onEditTags?: (entry: DirEntry) => void;
  onClearGeo?: (entry: DirEntry) => void;
  onCopyCoordinates?: (lat: number, lng: number) => void;
  /** Delete the right-clicked entry (trash or permanent per settings). */
  onDelete?: (entries: DirEntry[]) => void;
  onSave?: () => void;
  onSaveAs?: () => void;
  onCopyMap?: () => void;
  onSetLocationForSelection?: (lat: number, lng: number) => void;
  onClearLocationForSelection?: () => void;
  selectedCount: number;
  canEdit: boolean;
}

/**
 * H.26 P0-1: domain-aware context menu for the Mapique perspective. Handles
 * three surfaces:
 *   - marker right-click: file/location actions
 *   - tray row right-click: same file/location actions
 *   - blank map right-click: export + bulk location actions
 *
 * Does NOT reuse EntryContextMenu because Mapique needs location-domain
 * semantics (copy coordinates, clear location) rather than generic file ops.
 */
export default function MapiqueContextMenu({
  ctx,
  onClose,
  t,
  onOpen,
  onReveal,
  onEditTags,
  onClearGeo,
  onCopyCoordinates,
  onDelete,
  onSave,
  onSaveAs,
  onCopyMap,
  onSetLocationForSelection,
  onClearLocationForSelection,
  selectedCount,
  canEdit,
}: MapiqueContextMenuProps) {
  const entry = ctx?.entry;
  const isEntryMenu = ctx?.type === 'marker' || ctx?.type === 'tray';
  const isBlankMenu = ctx?.type === 'blank';
  const hasCoords = isEntryMenu && entry && ctx.lat !== undefined && ctx.lng !== undefined;

  return (
    <Menu
      open={ctx !== null}
      onClose={onClose}
      anchorReference="anchorPosition"
      anchorPosition={ctx ? { top: ctx.y, left: ctx.x } : undefined}
      slots={{ transition: NoTransition, backdrop: NoBackdrop }}
      slotProps={{
        paper: { onContextMenu: (e: React.MouseEvent) => e.preventDefault() },
      }}
    >
      {isEntryMenu && entry && (
        <>
          <MenuItem
            onClick={() => {
              onOpen?.(entry);
              onClose();
            }}
            data-testid="mapique-menu-open"
          >
            <ListItemIcon>
              <OpenInNewIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t('openFile')}</ListItemText>
          </MenuItem>

          <MenuItem
            onClick={() => {
              onReveal?.(entry);
              onClose();
            }}
            data-testid="mapique-menu-reveal"
          >
            <ListItemIcon>
              <FolderOpenIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t('revealInExplorer')}</ListItemText>
          </MenuItem>

          <MenuItem
            onClick={() => {
              onEditTags?.(entry);
              onClose();
            }}
            data-testid="mapique-menu-edit-tags"
          >
            <ListItemIcon>
              <EditIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t('mapiqueEditTags')}</ListItemText>
          </MenuItem>

          <MenuItem
            onClick={() => {
              onClearGeo?.(entry);
              onClose();
            }}
            disabled={!canEdit}
            data-testid="mapique-menu-clear-location"
          >
            <ListItemIcon>
              <LocationOffIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t('clearLocation')}</ListItemText>
          </MenuItem>

          {hasCoords && ctx.lat !== undefined && ctx.lng !== undefined && (
            <MenuItem
              onClick={() => {
                onCopyCoordinates?.(ctx.lat!, ctx.lng!);
                onClose();
              }}
              data-testid="mapique-menu-copy-coordinates"
            >
              <ListItemIcon>
                <ContentCopyIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{t('mapCopyCoords')}</ListItemText>
            </MenuItem>
          )}

          {/* Delete lives at the bottom of the entry branch, matching the
              Kanban/Gantt/Matrix domain menus; gated on canEdit like the
              other write actions. */}
          <MenuItem
            onClick={() => {
              onDelete?.([entry]);
              onClose();
            }}
            disabled={!canEdit}
            data-testid="mapique-menu-delete"
          >
            <ListItemIcon>
              <DeleteOutlineIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t('delete')}</ListItemText>
          </MenuItem>
        </>
      )}

      {isBlankMenu && (
        <>
          <MenuItem
            onClick={() => {
              onSave?.();
              onClose();
            }}
            disabled={!canEdit}
            data-testid="mapique-menu-save"
          >
            <ListItemIcon>
              <SaveIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t('saveImage')}</ListItemText>
          </MenuItem>

          <MenuItem
            onClick={() => {
              onSaveAs?.();
              onClose();
            }}
            disabled={!canEdit}
            data-testid="mapique-menu-save-as"
          >
            <ListItemIcon>
              <DriveFileMoveIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t('saveImageAs')}</ListItemText>
          </MenuItem>

          <MenuItem
            onClick={() => {
              onCopyMap?.();
              onClose();
            }}
            data-testid="mapique-menu-copy-map"
          >
            <ListItemIcon>
              <PhotoLibraryIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t('mapiqueCopyMap')}</ListItemText>
          </MenuItem>

          <MenuItem
            onClick={() => {
              if (ctx.lat !== undefined && ctx.lng !== undefined) {
                onSetLocationForSelection?.(ctx.lat, ctx.lng);
              }
              onClose();
            }}
            disabled={!canEdit || selectedCount === 0}
            data-testid="mapique-menu-set-location-selection"
          >
            <ListItemIcon>
              <AddLocationIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t('mapiqueSetLocationForSelection')}</ListItemText>
          </MenuItem>

          <MenuItem
            onClick={() => {
              onClearLocationForSelection?.();
              onClose();
            }}
            disabled={!canEdit || selectedCount === 0}
            data-testid="mapique-menu-clear-location-selection"
          >
            <ListItemIcon>
              <LocationOffIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{t('mapiqueClearLocationForSelection')}</ListItemText>
          </MenuItem>
        </>
      )}
    </Menu>
  );
}
