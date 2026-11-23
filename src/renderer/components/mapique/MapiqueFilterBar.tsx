import {
  Box,
  Checkbox,
  IconButton,
  InputAdornment,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ClearIcon from '@mui/icons-material/Close';
import LockIcon from '@mui/icons-material/Lock';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import SearchIcon from '@mui/icons-material/Search';
import type { TFunction } from 'i18next';

import type { TrayFilter, TraySort } from './constants';

export type SelectAllState = 'checked' | 'indeterminate' | 'unchecked';

export interface MapiqueFilterBarProps {
  t: TFunction;
  nameQuery: string;
  onNameQueryChange: (value: string) => void;
  selectAllState: SelectAllState;
  onToggleSelectAll: () => void;
  /** Size of the (already filtered) visible tray. */
  visibleCount: number;
  selectedCount: number;
  trayFilter: TrayFilter;
  onTrayFilterChange: (filter: TrayFilter) => void;
  traySort: TraySort;
  onTraySortChange: (sort: TraySort) => void;
  placeLocked: boolean;
  onTogglePlaceLocked: () => void;
  onCollapse: () => void;
}

/**
 * Mapique side-panel control bar: name search, select-all checkbox, tray
 * filter/sort selects, place-lock toggle and the collapse button.
 * Extracted from MapiqueView (P2 split); behaviour/JSX are unchanged.
 */
export default function MapiqueFilterBar({
  t,
  nameQuery,
  onNameQueryChange,
  selectAllState,
  onToggleSelectAll,
  visibleCount,
  selectedCount,
  trayFilter,
  onTrayFilterChange,
  traySort,
  onTraySortChange,
  placeLocked,
  onTogglePlaceLocked,
  onCollapse,
}: MapiqueFilterBarProps) {
  return (
    <>
      {/* File tray */}
      {/* P3-1: Name search — composes with `trayFilter` (located/unlocated) so
          the user can locate a file in large folders without leaving the
          map view. Search query is local state; cleared on view remount. */}
      <Box sx={{ px: 1.5, pt: 0.75, pb: 0.5 }}>
        <TextField
          size="small"
          fullWidth
          value={nameQuery}
          onChange={(e) => onNameQueryChange(e.target.value)}
          placeholder={t('mapiqueSearchPlaceholder')}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" sx={{ color: 'text.disabled' }} />
                </InputAdornment>
              ),
              endAdornment: nameQuery ? (
                <InputAdornment position="end">
                  <Tooltip title={t('mapiqueClearSearch')}>
                    <IconButton
                      size="small"
                      edge="end"
                      onClick={() => onNameQueryChange('')}
                      aria-label={t('mapiqueClearSearch')}
                    >
                      <ClearIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </InputAdornment>
              ) : null,
            },
          }}
        />
      </Box>

      <Stack
        direction="row"
        sx={{ px: 1.5, py: 0.5, alignItems: 'center', gap: 1 }}
      >
        <Checkbox
          size="small"
          checked={selectAllState === 'checked'}
          indeterminate={selectAllState === 'indeterminate'}
          onChange={onToggleSelectAll}
          disabled={visibleCount === 0}
          slotProps={{ input: { 'aria-label': t('selectAll') } }}
          sx={{ p: 0, mr: 0.5 }}
        />
        <Typography variant="overline" sx={{ flex: 1, fontSize: 10, lineHeight: 1.25 }} color="text.secondary">
          {t('files')} ({visibleCount})
          {selectedCount > 0 ? ` · ${selectedCount} ${t('selected')}` : ''}
        </Typography>

        <Select
          size="small"
          value={trayFilter}
          onChange={(e) => onTrayFilterChange(e.target.value as TrayFilter)}
          inputProps={{ 'aria-label': t('mapiqueFilterAll') }}
          sx={{ fontSize: 11, '& .MuiSelect-select': { py: 0.5 } }}
        >
          <MenuItem value="all" dense sx={{ fontSize: 12 }}>
            {t('mapiqueFilterAll')}
          </MenuItem>
          <MenuItem value="located" dense sx={{ fontSize: 12 }}>
            {t('mapiqueFilterLocated')}
          </MenuItem>
          <MenuItem value="unlocated" dense sx={{ fontSize: 12 }}>
            {t('mapiqueFilterUnlocated')}
          </MenuItem>
        </Select>

        {/* P3-5: tray row sort. Persisted per-location. `distance` is
            dynamic (re-orders as the map is panned). */}
        <Select
          size="small"
          value={traySort}
          onChange={(e) => onTraySortChange(e.target.value as TraySort)}
          inputProps={{ 'aria-label': t('mapiqueSort') }}
          sx={{ fontSize: 11, '& .MuiSelect-select': { py: 0.5 } }}
        >
          <MenuItem value="name" dense sx={{ fontSize: 12 }}>
            {t('mapiqueSortName')}
          </MenuItem>
          <MenuItem value="modified" dense sx={{ fontSize: 12 }}>
            {t('mapiqueSortModified')}
          </MenuItem>
          <MenuItem value="distance" dense sx={{ fontSize: 12 }}>
            {t('mapiqueSortDistance')}
          </MenuItem>
        </Select>

        <Tooltip title={placeLocked ? t('mapiquePlaceUnlock') : t('mapiquePlaceLock')}>
          <IconButton
            size="small"
            onClick={onTogglePlaceLocked}
            aria-label={placeLocked ? t('mapiquePlaceUnlock') : t('mapiquePlaceLock')}
            color={placeLocked ? 'default' : 'primary'}
          >
            {placeLocked ? (
              <LockIcon fontSize="small" />
            ) : (
              <LockOpenIcon fontSize="small" />
            )}
          </IconButton>
        </Tooltip>

        <Tooltip title={t('panelClose')}>
          <IconButton size="small" onClick={onCollapse}>
            <ChevronRightIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
    </>
  );
}
