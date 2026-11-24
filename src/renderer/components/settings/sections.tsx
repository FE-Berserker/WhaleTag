import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import {
  Box,
  Button,
  FormControl,
  MenuItem,
  Select,
  Slider,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import AccountTreeIcon from '@mui/icons-material/AccountTree';

import { RootState } from '-/reducers';
import {
  setThemeMode,
  setThemePreset,
  setLanguage,
  setFontSize,
  setDefaultLocation,
  setDeleteToTrash,
  setDefaultViewMode,
  setShowHiddenFiles,
  setShowLunar,
  setTaskReminderEnabled,
  setTaskReminderLocationId,
  setTaskReminderStageIds,
  setMapProvider,
  setMapTileUrl,
  setTagShape,
  setDefaultEntrySize,
  setKeybinding,
  resetKeybindings,
  DEFAULT_ENTRY_SIZE,
  type ThemeMode,
  type MapProvider,
} from '-/reducers/settings';
import type { ViewMode } from '../../../shared/whale-meta';
import {
  type TagShape,
  TAG_SHAPES,
  tagShapeSx,
  TAG_SHAPE_PREVIEW_COLORS,
  readableTextOn,
} from '../../domain/tag-colors';
import {
  MAPPABLE_KEYS,
  KEYBOARD_ACTIONS,
  type KeyAction,
} from '../../domain/keybindings';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from '-/i18n';
import { DEFAULT_PRESET_ID, THEME_MODE_PRESET_MAP } from '-/theme/presets';
import { tagDisplayLabel } from '-/services/tag-display';
import { getDefaultPendingStageIds } from '../../domain/task-reminder';
import { SettingsGroup, SettingsRow, ThemeModePicker } from './primitives';

const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  en: 'English',
  zh: '简体中文',
  'zh-TW': '繁體中文',
  ja: '日本語',
  ko: '한국어',
};

function TagShapePreview({ shape, label }: { shape: TagShape; label: string }) {
  return (
    <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
      <Box
        component="span"
        sx={{
          px: 1,
          py: 0.25,
          bgcolor: TAG_SHAPE_PREVIEW_COLORS[shape],
          fontSize: 12,
          fontWeight: 600,
          color: 'text.primary',
          ...tagShapeSx(shape),
        }}
      >
        Aa
      </Box>
      <Typography variant="body2">{label}</Typography>
    </Stack>
  );
}

export function GeneralSection() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const themeMode = useSelector((s: RootState) => s.settings.themeMode);
  const language = useSelector((s: RootState) => s.settings?.language ?? 'en');
  const fontSize = useSelector((s: RootState) => s.settings?.fontSize ?? 13);
  const defaultLocationId = useSelector(
    (s: RootState) => s.settings?.defaultLocationId ?? null
  );
  const locations = useSelector((s: RootState) => s.locations.items);
  const deleteToTrash = useSelector(
    (s: RootState) => s.settings?.deleteToTrash ?? true
  );
  const showHiddenFiles = useSelector(
    (s: RootState) => s.settings?.showHiddenFiles ?? false
  );
  const showLunar = useSelector((s: RootState) => s.settings?.showLunar ?? false);

  const handleThemeModeChange = (value: ThemeMode) => {
    dispatch(setThemeMode(value));
    // Keep themePreset in sync for backward compatibility with any code that
    // still reads it directly (e.g. extension views, persisted state consumers).
    const preset =
      THEME_MODE_PRESET_MAP[value as keyof typeof THEME_MODE_PRESET_MAP];
    dispatch(setThemePreset(preset?.presetId ?? DEFAULT_PRESET_ID));
  };

  return (
    <Stack sx={{ gap: 2 }}>
      <SettingsGroup title={t('settingsAppearance')}>
        <Box
          id="settings-anchor-theme"
          data-settings-row="settings-anchor-theme"
          sx={{ px: 2, py: 1.5 }}
        >
          <Typography variant="body2" sx={{ fontWeight: 500, mb: 1 }}>
            {t('theme')}
          </Typography>
          <ThemeModePicker value={themeMode} onChange={handleThemeModeChange} />
        </Box>

        <SettingsRow id="settings-anchor-font-size" label={t('fontSize')}>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={fontSize}
            onChange={(_, value: number | null) => {
              if (value) dispatch(setFontSize(value));
            }}
          >
            <ToggleButton value={12}>{t('fontSmall')}</ToggleButton>
            <ToggleButton value={13}>{t('fontMedium')}</ToggleButton>
            <ToggleButton value={15}>{t('fontLarge')}</ToggleButton>
            <ToggleButton value={17}>{t('fontXLarge')}</ToggleButton>
          </ToggleButtonGroup>
        </SettingsRow>

        <SettingsRow id="settings-anchor-language" label={t('language')}>
          <FormControl size="small" sx={{ minWidth: 140 }}>
            <Select
              value={language}
              onChange={(e) =>
                dispatch(setLanguage(e.target.value as SupportedLanguage))
              }
            >
              {SUPPORTED_LANGUAGES.map((lng) => (
                <MenuItem key={lng} value={lng}>
                  {LANGUAGE_LABELS[lng]}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t('settingsFiles')}>
        <SettingsRow
          id="settings-anchor-default-location"
          label={t('defaultLocation')}
          hint={t('defaultLocationHint')}
          fullWidth
        >
          <FormControl size="small" fullWidth>
            <Select
              value={
                defaultLocationId &&
                locations.some((l) => l.id === defaultLocationId)
                  ? defaultLocationId
                  : ''
              }
              displayEmpty
              onChange={(e) =>
                dispatch(setDefaultLocation(e.target.value || null))
              }
            >
              <MenuItem value="">
                <em>{t('noDefaultLocation')}</em>
              </MenuItem>
              {locations.map((loc) => (
                <MenuItem key={loc.id} value={loc.id}>
                  {loc.name}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </SettingsRow>

        <SettingsRow
          id="settings-anchor-delete-to-trash"
          label={t('deleteToTrash')}
          hint={t('deleteToTrashHint')}
        >
          <Switch
            checked={deleteToTrash}
            onChange={(e) => dispatch(setDeleteToTrash(e.target.checked))}
            slotProps={{ input: { 'aria-label': t('deleteToTrash') } }}
          />
        </SettingsRow>

        <SettingsRow
          id="settings-anchor-show-hidden-files"
          label={t('showHiddenFiles')}
          hint={t('showHiddenFilesHint')}
        >
          <Switch
            checked={showHiddenFiles}
            onChange={(e) => dispatch(setShowHiddenFiles(e.target.checked))}
            slotProps={{ input: { 'aria-label': t('showHiddenFiles') } }}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t('settingsCalendar')}>
        <SettingsRow
          id="settings-anchor-show-lunar"
          label={t('showLunar')}
          hint={t('showLunarHint')}
        >
          <Switch
            checked={showLunar}
            onChange={(e) => dispatch(setShowLunar(e.target.checked))}
            slotProps={{ input: { 'aria-label': t('showLunar') } }}
          />
        </SettingsRow>
      </SettingsGroup>
    </Stack>
  );
}

export function ViewSection() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const defaultViewMode = useSelector(
    (s: RootState) => s.settings?.defaultViewMode ?? 'list'
  );
  const defaultEntrySize = useSelector(
    (s: RootState) => s.settings?.defaultEntrySize ?? DEFAULT_ENTRY_SIZE
  );

  return (
    <SettingsGroup>
      <SettingsRow id="settings-anchor-default-view" label={t('defaultView')}>
        <Select<ViewMode>
          value={defaultViewMode}
          onChange={(e) =>
            dispatch(setDefaultViewMode(e.target.value as ViewMode))
          }
          size="small"
          sx={{ minWidth: 220 }}
        >
          <MenuItem value="list">{t('viewList')}</MenuItem>
          <MenuItem value="grid">{t('viewGrid')}</MenuItem>
          <MenuItem value="gallery">{t('viewGallery')}</MenuItem>
          {/* H.29: Kanban / Matrix moved into the 'task' perspective. The
              'task' option below hosts both layouts as a sub-switch. */}
          <MenuItem value="task">{t('viewTask')}</MenuItem>
          <MenuItem value="calendar">{t('viewCalendar')}</MenuItem>
          <MenuItem value="folderviz">{t('viewFolderViz')}</MenuItem>
          <MenuItem value="mapique">{t('viewMapique')}</MenuItem>
          <MenuItem value="tagcloud">{t('viewTagCloud')}</MenuItem>
          <MenuItem value="knowledge-graph">{t('viewKnowledgeGraph')}</MenuItem>
        </Select>
      </SettingsRow>

      <SettingsRow
        id="settings-anchor-entry-size"
        label={t('defaultEntrySize')}
        hint={t('defaultEntrySizeHint')}
        align="start"
      >
        <Stack
          direction="row"
          sx={{ alignItems: 'center', gap: 1.5, minWidth: 240, mt: 0.5 }}
        >
          <Slider
            size="small"
            min={64}
            max={320}
            step={8}
            value={defaultEntrySize}
            onChange={(_e, v) => dispatch(setDefaultEntrySize(v as number))}
            sx={{ flex: 1 }}
          />
          <Typography
            variant="body2"
            sx={{ minWidth: 44, textAlign: 'right' }}
          >
            {defaultEntrySize}px
          </Typography>
        </Stack>
      </SettingsRow>
    </SettingsGroup>
  );
}

export function MapSection() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const mapProvider = useSelector(
    (s: RootState) => s.settings?.mapProvider ?? 'gaode'
  );
  const mapTileUrl = useSelector((s: RootState) => s.settings?.mapTileUrl ?? '');

  return (
    <SettingsGroup>
      <SettingsRow id="settings-anchor-map-provider" label={t('mapProvider')}>
        <FormControl size="small" sx={{ minWidth: 200 }}>
          <Select
            value={mapProvider}
            onChange={(e) =>
              dispatch(setMapProvider(e.target.value as MapProvider))
            }
          >
            <MenuItem value="gaode">{t('mapProviderGaode')}</MenuItem>
            <MenuItem value="osm">{t('mapProviderOsm')}</MenuItem>
          </Select>
        </FormControl>
      </SettingsRow>

      <SettingsRow
        id="settings-anchor-map-tile-url"
        label={t('mapTileUrl')}
        hint={t('mapTileUrlHint')}
        fullWidth
      >
        <TextField
          size="small"
          fullWidth
          placeholder={t('mapTileUrlPlaceholder')}
          value={mapTileUrl}
          onChange={(e) => dispatch(setMapTileUrl(e.target.value))}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

/** Tags & Workflow: tag appearance, the workflow stage editor entry point, and
 *  pointers to where groups/library/smart tags live (the left sidebar panel,
 *  which remains the single source of truth for per-tag colors and drag-to-
 *  group). */
export function TagsSection({
  onOpenWorkflowManager,
}: {
  onOpenWorkflowManager: () => void;
}) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const stages = useSelector((s: RootState) => s.workflow?.stages ?? []);
  const tagShape = useSelector((s: RootState) => s.settings?.tagShape ?? 'rounded');

  return (
    <Stack sx={{ gap: 2 }}>
      <SettingsGroup title={t('settingsTagLook')}>
        <SettingsRow
          id="settings-anchor-tag-shape"
          label={t('tagShape')}
          hint={t('tagShapeHint')}
        >
          <FormControl size="small" sx={{ minWidth: 180 }}>
            <Select
              value={tagShape}
              onChange={(e) => dispatch(setTagShape(e.target.value as TagShape))}
              renderValue={(value) => {
                const shape = value as TagShape;
                const label = t(
                  `tagShape${shape[0].toUpperCase()}${shape.slice(1)}`
                );
                return <TagShapePreview shape={shape} label={label} />;
              }}
            >
              {TAG_SHAPES.map((shape) => {
                const label = t(
                  `tagShape${shape[0].toUpperCase()}${shape.slice(1)}`
                );
                return (
                  <MenuItem key={shape} value={shape}>
                    <TagShapePreview shape={shape} label={label} />
                  </MenuItem>
                );
              })}
            </Select>
          </FormControl>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title={t('tagsWorkflowSettings')}
        description={t('tagsWorkflowSettingsHint')}
      >
        <Box
          sx={{
            px: 2,
            py: 1.5,
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            flexWrap: 'wrap',
          }}
        >
          <Button
            variant="outlined"
            size="small"
            startIcon={<AccountTreeIcon />}
            onClick={onOpenWorkflowManager}
            data-testid="open-workflow-manager"
          >
            {t('openWorkflowManager')}
          </Button>
          <Typography variant="caption" color="text.secondary">
            {t('taskReminderStagesCount', { count: stages.length })}
          </Typography>
        </Box>
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow label={t('tagGroups')} hint={t('tagsGroupsHint')} />
        <SettingsRow label={t('tagLibrary')} hint={t('tagsLibraryHint')} />
        <SettingsRow label={t('smartTags')} hint={t('tagsSmartTagsHint')} />
      </SettingsGroup>
    </Stack>
  );
}

export function NotificationsSection() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const locations = useSelector((s: RootState) => s.locations.items);
  const taskReminderEnabled = useSelector(
    (s: RootState) => s.settings?.taskReminderEnabled ?? false
  );
  const taskReminderLocationId = useSelector(
    (s: RootState) => s.settings?.taskReminderLocationId ?? null
  );
  const taskReminderStageIds = useSelector(
    (s: RootState) => s.settings?.taskReminderStageIds ?? null
  );
  const stages = useSelector((s: RootState) => s.workflow?.stages ?? []);

  const defaultIds = getDefaultPendingStageIds(stages);
  const effectiveIds =
    taskReminderStageIds === null ? defaultIds : taskReminderStageIds;

  return (
    <Stack sx={{ gap: 2 }}>
      <SettingsGroup>
        <SettingsRow
          id="settings-anchor-task-reminder"
          label={t('taskReminder')}
          hint={t('taskReminderHint')}
        >
          <Switch
            checked={taskReminderEnabled}
            slotProps={{ input: { 'aria-label': t('taskReminder') } }}
            onChange={(e) => dispatch(setTaskReminderEnabled(e.target.checked))}
          />
        </SettingsRow>
      </SettingsGroup>

      {taskReminderEnabled ? (
        <SettingsGroup title={t('taskReminderStages')} description={t('taskReminderStagesHint')}>
          <SettingsRow label={t('taskReminderLocation')} fullWidth>
            <FormControl size="small" fullWidth>
              <Select
                value={
                  taskReminderLocationId &&
                  locations.some((l) => l.id === taskReminderLocationId)
                    ? taskReminderLocationId
                    : ''
                }
                displayEmpty
                onChange={(e) =>
                  dispatch(setTaskReminderLocationId(e.target.value || null))
                }
              >
                <MenuItem value="">
                  <em>{t('taskReminderLocation')}</em>
                </MenuItem>
                {locations.map((loc) => (
                  <MenuItem key={loc.id} value={loc.id}>
                    {loc.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </SettingsRow>

          <Box sx={{ px: 2, py: 1.5 }}>
            {stages.length === 0 ? (
              <Typography variant="caption" color="text.secondary">
                {t('kanbanNoStages')}
              </Typography>
            ) : (
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                {stages.map((stage) => {
                  const selected = effectiveIds.includes(stage.id);
                  return (
                    <ToggleButton
                      key={stage.id}
                      value={stage.id}
                      selected={selected}
                      onChange={() => {
                        const current = effectiveIds;
                        const next = selected
                          ? current.filter((id) => id !== stage.id)
                          : [...current, stage.id];
                        dispatch(setTaskReminderStageIds(next));
                      }}
                      size="small"
                      sx={{
                        px: 1.5,
                        py: 0.25,
                        borderRadius: 1,
                        textTransform: 'none',
                        fontSize: '0.8125rem',
                        lineHeight: 1.25,
                        ...(selected
                          ? {
                              bgcolor: stage.color,
                              color: readableTextOn(stage.color),
                              border: 'none',
                              '&:hover': { bgcolor: stage.color },
                            }
                          : {
                              bgcolor: 'background.paper',
                              color: 'text.secondary',
                              border: (theme) =>
                                `1px solid ${theme.palette.divider}`,
                            }),
                      }}
                    >
                      {tagDisplayLabel(stage.value, t)}
                    </ToggleButton>
                  );
                })}
              </Box>
            )}
          </Box>
        </SettingsGroup>
      ) : null}
    </Stack>
  );
}

/**
 * Keyboard shortcut bindings (key → action). Each mappable key gets a row with
 * a dropdown of every available action (plus "None", which clears the binding
 * and restores that key's browser default — notably Tab focus traversal). The
 * bindings take effect in the list/grid file views.
 */
export function KeyboardSection() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const keybindings = useSelector((s: RootState) => s.settings?.keybindings);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const visible = MAPPABLE_KEYS.filter(
    ({ labelKey }) => !q || t(labelKey).toLowerCase().includes(q)
  );

  return (
    <Stack sx={{ gap: 2 }}>
      <Box
        component="input"
        type="text"
        aria-label={t('keybindingsSearch')}
        placeholder={t('keybindingsSearch')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        sx={{
          width: '100%',
          height: 40,
          boxSizing: 'border-box',
          padding: '0 10px',
          fontSize: 14,
          fontFamily: 'inherit',
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          background: 'transparent',
          color: 'inherit',
          '&:focus-visible': {
            outline: '2px solid',
            outlineColor: 'primary.main',
            outlineOffset: 2,
          },
        }}
      />

      {visible.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {t('settingsSearchEmpty')}
        </Typography>
      ) : (
        <SettingsGroup>
          {visible.map(({ token, labelKey }) => (
            <SettingsRow key={token} label={t(labelKey)}>
              <Select<KeyAction>
                value={keybindings?.[token] ?? 'none'}
                onChange={(e) =>
                  dispatch(setKeybinding(token, e.target.value as KeyAction))
                }
                size="small"
                sx={{ minWidth: 200 }}
              >
                {KEYBOARD_ACTIONS.map(
                  ({ value, labelKey: actionLabelKey }) => (
                    <MenuItem key={value} value={value}>
                      {t(actionLabelKey)}
                    </MenuItem>
                  )
                )}
              </Select>
            </SettingsRow>
          ))}
        </SettingsGroup>
      )}

      <Box>
        <Button
          size="small"
          variant="outlined"
          onClick={() => dispatch(resetKeybindings())}
        >
          {t('resetKeybindings')}
        </Button>
      </Box>
    </Stack>
  );
}
