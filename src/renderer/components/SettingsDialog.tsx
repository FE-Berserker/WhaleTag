import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import {
  Avatar,
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  MenuItem,
  Select,
  Slider,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import Brightness7Icon from '@mui/icons-material/Brightness7';
import Brightness4Icon from '@mui/icons-material/Brightness4';
import SettingsBrightnessIcon from '@mui/icons-material/SettingsBrightness';
import WbSunnyIcon from '@mui/icons-material/WbSunny';
import NightsStayIcon from '@mui/icons-material/NightsStay';
import AcUnitIcon from '@mui/icons-material/AcUnit';
import WaterDropIcon from '@mui/icons-material/WaterDrop';
import WbTwilightIcon from '@mui/icons-material/WbTwilight';
import ParkIcon from '@mui/icons-material/Park';
import ContrastIcon from '@mui/icons-material/Contrast';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import TerminalIcon from '@mui/icons-material/Terminal';
import TuneIcon from '@mui/icons-material/Tune';
import { AiComponentSection } from './AiComponentSection';
import UpdateSection from './UpdateSection';
import UserCommandsSection from './UserCommandsSection';
import CustomCalloutsSection from './CustomCalloutsSection';
import VisibilityIcon from '@mui/icons-material/Visibility';
import StickyNote2Icon from '@mui/icons-material/StickyNote2';
import MapIcon from '@mui/icons-material/Map';
import StyleIcon from '@mui/icons-material/Style';
import NotificationsIcon from '@mui/icons-material/Notifications';
import SettingsIcon from '@mui/icons-material/Settings';
import AddIcon from '@mui/icons-material/Add';
import RefreshIcon from '@mui/icons-material/Refresh';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import KeyboardIcon from '@mui/icons-material/Keyboard';
import ArchitectureIcon from '@mui/icons-material/Architecture';
import MenuBookIcon from '@mui/icons-material/MenuBook';
import AutoModeIcon from '@mui/icons-material/AutoMode';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import HelpIcon from '@mui/icons-material/Help';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import SearchIcon from '@mui/icons-material/Search';

import { RootState } from '-/reducers';
import {
  setThemeMode,
  setThemePreset,
  setLanguage,
  setFontSize,
  setDefaultLocation,
  addFulltextPath,
  removeFulltextPath,
  setDeleteToTrash,
  setDefaultViewMode,
  setOfficeThumbnailEnabled,
  setShowHiddenFiles,
  setShowLunar,
  setSofficePath,
  setDwg2dxfPath,
  setOdaPath,
  setCalibrePath,
  setTaskReminderEnabled,
  setTaskReminderLocationId,
  setTaskReminderStageIds,
  setMapProvider,
  setMapTileUrl,
  setTagShape,
  setDefaultEntrySize,
  setKeybinding,
  resetKeybindings,
  setAiSettings,
  setMdRenderTheme,
  DEFAULT_ENTRY_SIZE,
  normalizeFsPath,
  type ThemeMode,
  type MapProvider,
} from '-/reducers/settings';
import { setExtensionEnabled, setDefaultExtension } from '-/reducers/extensions';
import type { MdRenderThemePref } from '../../shared/extension-types';
import type { ViewMode } from '../../shared/whale-meta';
import {
  type TagShape,
  TAG_SHAPES,
  tagShapeSx,
  TAG_SHAPE_PREVIEW_COLORS,
} from '../domain/tag-colors';
import {
  MAPPABLE_KEYS,
  KEYBOARD_ACTIONS,
  type KeyAction,
} from '../domain/keybindings';
import { useCurrentLocationContext } from '-/hooks/CurrentLocationContextProvider';
import { ipcApi } from '-/services/ipc-api';
import AiMcpSection from '-/components/ai/AiMcpSection';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from '-/i18n';
import { THEME_MODE_PRESET_MAP } from '-/theme/presets';
import { tagDisplayLabel } from '-/services/tag-display';
import { readableTextOn } from '../domain/tag-colors';
import { getDefaultPendingStageIds } from '../domain/task-reminder';
import type { ExtensionManifest } from '../../shared/extension-types';
import WorkflowManagerDialog from '-/components/WorkflowManagerDialog';

const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  en: 'English',
  zh: '简体中文',
  'zh-TW': '繁體中文',
  ja: '日本語',
  ko: '한국어',
};

/** The IDs are also persisted as the "settings section to open" prop from
 *  callers (e.g. Sidebar's tag-management shortcut jumps straight to `tags`). */
export type SettingsSectionId =
  | 'general'
  | 'view'
  | 'keyboard'
  | 'mapique'
  | 'tags'
  | 'notifications'
  | 'ai'
  | 'commands'
  | 'callouts'
  | 'about'
  | 'advanced';

interface SettingsDialogProps {
  open: boolean;
  /** Section to focus each time the dialog (re-)opens. */
  section?: SettingsSectionId;
  onClose: () => void;
}

// `SettingsDialogProps` is re-exported below for the provider to type its
// `openDialog({ section })` argument without re-declaring the field. Keep
// `interface` (not `type`) so consumers can `extends` it if needed.
export type { SettingsDialogProps };

/** A small row: a label on the left, a control on the right. */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <Stack
      direction="row"
      sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 2 }}
    >
      <Stack sx={{ minWidth: 0 }}>
        <Typography variant="body2">{label}</Typography>
        {hint ? (
          <Typography variant="caption" color="text.secondary">
            {hint}
          </Typography>
        ) : null}
      </Stack>
      {children}
    </Stack>
  );
}

type BuildState = 'unbuilt' | 'building' | 'ready' | 'error';
interface FtStatus {
  state: BuildState;
  count?: number;
  error?: string;
}

/**
 * Extensions management: enable/disable built-in extensions and choose the
 * default handler for each file type. Only file types with multiple compatible
 * extensions show a default selector.
 */
function ExtensionsSection() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const registry = useSelector((s: RootState) => s.extensions.registry);
  const userDefaults = useSelector(
    (s: RootState) => s.extensions.userDefaults
  );
  const enabledOverrides = useSelector(
    (s: RootState) => s.extensions.enabledOverrides
  );

  if (!registry || registry.extensions.length === 0) {
    return (
      <>
        <Divider />
        <Typography variant="overline" color="text.secondary">
          {t('extensionsSettings')}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {t('extensionNoRegistry')}
        </Typography>
      </>
    );
  }

  const extensions = registry.extensions;

  const isEnabled = (m: ExtensionManifest) => {
    const override = enabledOverrides[m.id];
    return override !== undefined ? override : m.enabled;
  };

  // Map file type -> enabled compatible extension manifests.
  const byType: Record<string, ExtensionManifest[]> = {};
  for (const m of extensions) {
    if (!isEnabled(m)) continue;
    for (const ft of m.fileTypes) {
      (byType[ft] ??= []).push(m);
    }
  }
  const contestedTypes = Object.keys(byType)
    .filter((ft) => byType[ft].length > 1)
    .sort();

  return (
    <>
      <Divider />
      <Stack
        direction="row"
        sx={{ alignItems: 'center', justifyContent: 'space-between' }}
      >
        <Typography variant="overline" color="text.secondary">
          {t('extensionsSettings')}
        </Typography>
        <Button
          size="small"
          onClick={() => {
            for (const ft of Object.keys(userDefaults)) {
              dispatch(setDefaultExtension(ft, null));
            }
            for (const id of Object.keys(enabledOverrides)) {
              dispatch(setExtensionEnabled(id, true));
            }
          }}
        >
          {t('resetExtensionDefaults')}
        </Button>
      </Stack>

      <Stack sx={{ gap: 1 }}>
        {extensions.map((m) => (
          <Stack
            key={m.id}
            direction="row"
            spacing={1.5}
            sx={{ alignItems: 'center' }}
          >
            <Box
              sx={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                bgcolor: m.color,
                flexShrink: 0,
              }}
            />
            <Stack sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="body2" noWrap>
                {m.name}
              </Typography>
              <Typography variant="caption" color="text.secondary" noWrap>
                {m.fileTypes.map((ft) => `.${ft}`).join(', ')}
              </Typography>
            </Stack>
            <Chip
              label={t(m.type === 'viewer' ? 'viewer' : 'editor')}
              size="small"
              variant="outlined"
              sx={{ flexShrink: 0 }}
            />
            <Switch
              size="small"
              checked={isEnabled(m)}
              onChange={(e) =>
                dispatch(setExtensionEnabled(m.id, e.target.checked))
              }
              slotProps={{
                input: { 'aria-label': `${m.name} enabled` },
              }}
            />
          </Stack>
        ))}
      </Stack>

      {contestedTypes.length > 0 ? (
        <>
          <Typography variant="caption" color="text.secondary">
            {t('extensionDefaultForHint')}
          </Typography>
          <Stack sx={{ gap: 1 }}>
            {contestedTypes.map((ft) => {
              const current = userDefaults[ft];
              const valid = byType[ft].some((m) => m.id === current)
                ? current
                : '';
              return (
                <Stack
                  key={ft}
                  direction="row"
                  spacing={1.5}
                  sx={{ alignItems: 'center' }}
                >
                  <Typography
                    variant="body2"
                    sx={{ width: 80, flexShrink: 0 }}
                  >
                    .{ft}
                  </Typography>
                  <FormControl size="small" fullWidth>
                    <Select
                      value={valid}
                      displayEmpty
                      onChange={(e) =>
                        dispatch(
                          setDefaultExtension(ft, e.target.value || null)
                        )
                      }
                    >
                      <MenuItem value="">
                        <em>{t('noDefaultExtension')}</em>
                      </MenuItem>
                      {byType[ft].map((m) => (
                        <MenuItem key={m.id} value={m.id}>
                          {m.name}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                </Stack>
              );
            })}
          </Stack>
        </>
      ) : null}
    </>
  );
}

/**
 * Full-text settings: the list of directories with content search enabled.
 * Each path is an independent index root (may be a location root or any
 * subdirectory). Adding or rebuilding triggers a main-process build; build
 * status is kept locally (redux only stores the path list).
 */
function FulltextSection() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const paths = useSelector((s: RootState) => s.settings?.fulltextPaths ?? []);
  const { currentLocation } = useCurrentLocationContext();

  const [input, setInput] = useState('');
  const [status, setStatus] = useState<Record<string, FtStatus>>({});

  const build = useCallback(async (p: string) => {
    const key = normalizeFsPath(p);
    console.log('[SettingsDialog] build start:', p, 'key:', key);
    setStatus((prev) => ({ ...prev, [key]: { state: 'building' } }));
    try {
      console.log('[SettingsDialog] calling ipcApi.buildFulltextIndex:', p);
      const { count } = await ipcApi.buildFulltextIndex(p);
      console.log('[SettingsDialog] build success:', p, 'count:', count);
      setStatus((prev) => ({ ...prev, [key]: { state: 'ready', count } }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error('[SettingsDialog] build failed:', p, message, e);
      setStatus((prev) => ({ ...prev, [key]: { state: 'error', count: undefined, error: message } }));
    }
  }, []);

  // Reset status when the path list changes (e.g. add/remove) so we don't
  // show stale counts from a previous session.
  useEffect(() => {
    setStatus({});
  }, [paths]);

  // Probe existing indexes for paths we don't yet have a status for.
  useEffect(() => {
    for (const p of paths) {
      const key = normalizeFsPath(p);
      if (status[key]) continue;
      void ipcApi.hasFulltextIndex(p).then((has) => {
        setStatus((prev) =>
          prev[key]
            ? prev
            : { ...prev, [key]: { state: has ? 'ready' : 'unbuilt' } }
        );
      });
    }
  }, [paths]);

  const handleAdd = () => {
    const v = input.trim();
    if (!v) return;
    dispatch(addFulltextPath(v));
    setInput('');
    void build(v);
  };

  const statusLabel = (st: FtStatus | undefined): string => {
    if (!st) return '';
    if (st.state === 'building') return t('fulltextBuilding');
    if (st.state === 'error') return `${t('errorOccurred')}${st.error ? `: ${st.error}` : ''}`;
    if (st.state === 'ready')
      return st.count !== undefined
        ? t('entriesIndexed', { count: st.count })
        : t('fulltextReady');
    return t('fulltextNotBuilt');
  };

  return (
    <ConverterCard
      icon={<SearchIcon />}
      title={t('fulltextSearch')}
      hint={t('fulltextHint')}
    >
      <Stack direction="row" sx={{ gap: 1 }}>
        <TextField
          size="small"
          fullWidth
          placeholder={t('fulltextPathPlaceholder')}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd();
          }}
        />
        <Tooltip title={t('add')}>
          <span>
            <IconButton
              size="small"
              color="primary"
              onClick={handleAdd}
              disabled={!input.trim()}
            >
              <AddIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
      {currentLocation ? (
        <Button
          size="small"
          sx={{ alignSelf: 'flex-start', mt: -1 }}
          onClick={() => setInput(currentLocation.path)}
        >
          {t('useCurrentLocation')}
        </Button>
      ) : null}

      {paths.length === 0 ? (
        <Typography variant="caption" color="text.secondary">
          {t('fulltextHint')}
        </Typography>
      ) : (
        <Stack sx={{ gap: 0.5 }}>
          {paths.map((p) => {
            const st = status[normalizeFsPath(p)];
            const busy = st?.state === 'building';
            return (
              <Stack
                key={p}
                direction="row"
                sx={{ alignItems: 'center', gap: 0.5 }}
              >
                <Stack sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2" noWrap title={p}>
                    {p}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {statusLabel(st)}
                  </Typography>
                </Stack>
                <Tooltip title={t('rebuildIndex')}>
                  <span>
                    <IconButton
                      size="small"
                      data-testid="rebuild-fulltext-button"
                      data-path={p}
                      onClick={() => void build(p)}
                      disabled={busy}
                    >
                      <RefreshIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
                <Tooltip title={t('remove')}>
                  <IconButton
                    size="small"
                    onClick={() => dispatch(removeFulltextPath(p))}
                  >
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
            );
          })}
        </Stack>
      )}
      <Typography variant="caption" color="text.secondary" sx={{ mt: -1 }}>
        {t('fulltextNote')}
      </Typography>
    </ConverterCard>
  );
}

/** Section header used by each pane. */
function SectionHeader({
  title,
  hint,
}: {
  title: string;
  hint?: string;
}) {
  return (
    <Stack sx={{ mb: 1.5 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
        {title}
      </Typography>
      {hint ? (
        <Typography variant="caption" color="text.secondary">
          {hint}
        </Typography>
      ) : null}
    </Stack>
  );
}

function GeneralSection() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const themeMode = useSelector((s: RootState) => s.settings.themeMode);
  const mdRenderTheme = useSelector(
    (s: RootState) => s.settings.mdEditorRenderTheme ?? 'auto'
  );
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
    const preset = THEME_MODE_PRESET_MAP[value as keyof typeof THEME_MODE_PRESET_MAP];
    if (preset) dispatch(setThemePreset(preset.presetId));
  };

  const THEME_OPTIONS: { value: ThemeMode; labelKey: string; Icon: typeof Brightness7Icon }[] = [
    { value: 'system', labelKey: 'system', Icon: SettingsBrightnessIcon },
    { value: 'light', labelKey: 'light', Icon: Brightness7Icon },
    { value: 'dark', labelKey: 'dark', Icon: Brightness4Icon },
    { value: 'warm-paper', labelKey: 'presetWarmPaper', Icon: WbSunnyIcon },
    { value: 'midnight-plum', labelKey: 'presetMidnightPlum', Icon: NightsStayIcon },
    { value: 'frosted-mint', labelKey: 'presetFrostedMint', Icon: AcUnitIcon },
    { value: 'deep-ocean', labelKey: 'presetDeepOcean', Icon: WaterDropIcon },
    { value: 'dawn-blush', labelKey: 'presetDawnBlush', Icon: WbTwilightIcon },
    { value: 'forest-ink', labelKey: 'presetForestInk', Icon: ParkIcon },
    { value: 'soft-amber', labelKey: 'presetSoftAmber', Icon: WbSunnyIcon },
    { value: 'high-contrast', labelKey: 'presetHighContrast', Icon: ContrastIcon },
  ];

  return (
    <Stack sx={{ gap: 2 }}>
      <Field label={t('theme')}>
        <FormControl size="small" sx={{ minWidth: 180 }}>
          <Select
            value={themeMode}
            onChange={(e) => handleThemeModeChange(e.target.value as ThemeMode)}
            renderValue={(value) => {
              const option = THEME_OPTIONS.find((o) => o.value === value);
              if (!option) return null;
              const { Icon, labelKey } = option;
              return (
                <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
                  <Icon fontSize="small" />
                  <Typography variant="body2">{t(labelKey)}</Typography>
                </Stack>
              );
            }}
          >
            {THEME_OPTIONS.map(({ value, labelKey, Icon }) => (
              <MenuItem key={value} value={value}>
                <Stack direction="row" sx={{ alignItems: 'center', gap: 1 }}>
                  <Icon fontSize="small" />
                  <Typography variant="body2">{t(labelKey)}</Typography>
                </Stack>
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Field>

      <Field label={t('mdRenderTheme')}>
        <FormControl size="small" sx={{ minWidth: 180 }}>
          <Select
            value={mdRenderTheme}
            onChange={(e) =>
              dispatch(setMdRenderTheme(e.target.value as MdRenderThemePref))
            }
          >
            <MenuItem value="auto">{t('mdRenderThemeAuto')}</MenuItem>
            <MenuItem value="github-light">GitHub Light</MenuItem>
            <MenuItem value="github-dark">GitHub Dark</MenuItem>
            <MenuItem value="solarized-light">Solarized Light</MenuItem>
            <MenuItem value="solarized-dark">Solarized Dark</MenuItem>
            <MenuItem value="dracula">Dracula</MenuItem>
            <MenuItem value="nord">Nord</MenuItem>
            <MenuItem value="gruvbox">Gruvbox</MenuItem>
            <MenuItem value="one-dark">One Dark</MenuItem>
          </Select>
        </FormControl>
      </Field>

      <Field label={t('fontSize')}>
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
      </Field>

      <Field label={t('language')}>
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
      </Field>

      <Divider />

      <Typography variant="overline" color="text.secondary">
        {t('defaultLocation')}
      </Typography>

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
      <Typography variant="caption" color="text.secondary" sx={{ mt: -1.5 }}>
        {t('defaultLocationHint')}
      </Typography>

      <Field label={t('deleteToTrash')} hint={t('deleteToTrashHint')}>
        <Switch
          checked={deleteToTrash}
          onChange={(e) => dispatch(setDeleteToTrash(e.target.checked))}
        />
      </Field>

      <Field label={t('showHiddenFiles')} hint={t('showHiddenFilesHint')}>
        <FormControlLabel
          control={
            <Switch
              checked={showHiddenFiles}
              onChange={(e) =>
                dispatch(setShowHiddenFiles(e.target.checked))
              }
            />
          }
          label={t('enabled')}
        />
      </Field>

      <Field label={t('showLunar')} hint={t('showLunarHint')}>
        <FormControlLabel
          control={
            <Switch
              checked={showLunar}
              onChange={(e) => dispatch(setShowLunar(e.target.checked))}
            />
          }
          label={t('enabled')}
        />
      </Field>
    </Stack>
  );
}

function ViewSection() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const defaultViewMode = useSelector(
    (s: RootState) => s.settings?.defaultViewMode ?? 'list'
  );
  const defaultEntrySize = useSelector(
    (s: RootState) => s.settings?.defaultEntrySize ?? DEFAULT_ENTRY_SIZE
  );
  const tagShape = useSelector(
    (s: RootState) => s.settings?.tagShape ?? 'rounded'
  );
  const officeThumbnailEnabled = useSelector(
    (s: RootState) => s.settings?.officeThumbnailEnabled ?? false
  );
  const sofficePath = useSelector(
    (s: RootState) => s.settings?.sofficePath ?? null
  );

  return (
    <Stack sx={{ gap: 2 }}>
      <Field label={t('defaultView')}>
        <Select<ViewMode>
          value={defaultViewMode}
          onChange={(e) => dispatch(setDefaultViewMode(e.target.value as ViewMode))}
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
      </Field>

      <Field
        label={t('defaultEntrySize')}
        hint={t('defaultEntrySizeHint')}
      >
        <Stack
          direction="row"
          sx={{ alignItems: 'center', gap: 1.5, minWidth: 240 }}
        >
          <Slider
            size="small"
            min={64}
            max={320}
            step={8}
            value={defaultEntrySize}
            onChange={(_e, v) =>
              dispatch(setDefaultEntrySize(v as number))
            }
            sx={{ flex: 1 }}
          />
          <Typography
            variant="body2"
            sx={{ minWidth: 40, textAlign: 'right' }}
          >
            {defaultEntrySize}px
          </Typography>
        </Stack>
      </Field>

      <Field label={t('tagShape')} hint={t('tagShapeHint')}>
        <FormControl size="small" sx={{ minWidth: 180 }}>
          <Select
            value={tagShape}
            onChange={(e) => dispatch(setTagShape(e.target.value as TagShape))}
            renderValue={(value) => {
              const shape = value as TagShape;
              const label = t(
                `tagShape${shape[0].toUpperCase()}${shape.slice(1)}`,
              );
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
            }}
          >
            {TAG_SHAPES.map((shape) => {
              const label = t(
                `tagShape${shape[0].toUpperCase()}${shape.slice(1)}`,
              );
              return (
                <MenuItem key={shape} value={shape}>
                  <Stack
                    direction="row"
                    sx={{ alignItems: 'center', gap: 1 }}
                  >
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
                </MenuItem>
              );
            })}
          </Select>
        </FormControl>
      </Field>

      <Divider />

      <Field
        label={t('officeThumbnails')}
        hint={t('officeThumbnailsHint')}
      >
        <FormControlLabel
          control={
            <Switch
              checked={officeThumbnailEnabled}
              onChange={(e) =>
                dispatch(setOfficeThumbnailEnabled(e.target.checked))
              }
            />
          }
          label={t('enabled')}
        />
      </Field>
      {officeThumbnailEnabled ? (
        <Field label={t('sofficePath')} hint={t('sofficePathHint')}>
          <TextField
            size="small"
            fullWidth
            placeholder={t('sofficePathPlaceholder')}
            value={sofficePath ?? ''}
            onChange={(e) =>
              dispatch(setSofficePath(e.target.value.trim() || null))
            }
          />
        </Field>
      ) : null}
    </Stack>
  );
}

function MapSection() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const mapProvider = useSelector(
    (s: RootState) => s.settings?.mapProvider ?? 'gaode'
  );
  const mapTileUrl = useSelector(
    (s: RootState) => s.settings?.mapTileUrl ?? ''
  );

  return (
    <Stack sx={{ gap: 2 }}>
      <Field label={t('mapProvider')}>
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
      </Field>

      <Field label={t('mapTileUrl')} hint={t('mapTileUrlHint')}>
        <TextField
          size="small"
          fullWidth
          placeholder={t('mapTileUrlPlaceholder')}
          value={mapTileUrl}
          onChange={(e) => dispatch(setMapTileUrl(e.target.value))}
        />
      </Field>
    </Stack>
  );
}

/** Tags & Workflow section: workflows are edited inline (button opens the
 *  existing WorkflowManagerDialog as a nested dialog). Tag groups and the
 *  full library continue to live in the sidebar's Tags panel, which is where
 *  per-tag colors and drag-to-group already work — pointing at it from here
 *  keeps one source of truth. */
function TagsSection({
  onOpenWorkflowManager,
}: {
  onOpenWorkflowManager: () => void;
}) {
  const { t } = useTranslation();
  const stages = useSelector((s: RootState) => s.workflow?.stages ?? []);

  return (
    <Stack sx={{ gap: 2 }}>
      <Typography variant="body2" color="text.secondary">
        {t('tagsSettingsSectionHint')}
      </Typography>

      <Box>
        <SectionHeader
          title={t('tagsWorkflowSettings')}
          hint={t('tagsWorkflowSettingsHint')}
        />
        <Stack
          direction="row"
          sx={{ alignItems: 'center', gap: 2, flexWrap: 'wrap' }}
        >
          <Button
            variant="outlined"
            startIcon={<AccountTreeIcon />}
            onClick={onOpenWorkflowManager}
            data-testid="open-workflow-manager"
          >
            {t('openWorkflowManager')}
          </Button>
          <Typography variant="caption" color="text.secondary">
            {t('taskReminderStagesCount', { count: stages.length })}
          </Typography>
        </Stack>
      </Box>

      <Divider />

      <Box>
        <SectionHeader title={t('tagGroups')} />
        <Typography variant="body2" color="text.secondary">
          {t('tagsGroupsHint')}
        </Typography>
      </Box>

      <Box>
        <SectionHeader title={t('tagLibrary')} />
        <Typography variant="body2" color="text.secondary">
          {t('tagsLibraryHint')}
        </Typography>
      </Box>

      <Box>
        <SectionHeader title={t('smartTags')} />
        <Typography variant="body2" color="text.secondary">
          {t('tagsSmartTagsHint')}
        </Typography>
      </Box>
    </Stack>
  );
}

function NotificationsSection() {
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

  return (
    <Stack sx={{ gap: 2 }}>
      <Field label={t('taskReminder')} hint={t('taskReminderHint')}>
        <Switch
          checked={taskReminderEnabled}
          onChange={(e) =>
            dispatch(setTaskReminderEnabled(e.target.checked))
          }
        />
      </Field>
      {taskReminderEnabled ? (
        <>
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

          <Stack sx={{ gap: 0.5 }}>
            <Typography variant="caption" color="text.secondary">
              {t('taskReminderStages')}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {t('taskReminderStagesHint')}
            </Typography>
            {stages.length === 0 ? (
              <Typography variant="caption" color="text.secondary">
                {t('kanbanNoStages')}
              </Typography>
            ) : (
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                {(() => {
                  const defaultIds = getDefaultPendingStageIds(stages);
                  const effectiveIds =
                    taskReminderStageIds === null
                      ? defaultIds
                      : taskReminderStageIds;
                  return stages.map((stage) => {
                    const selected = effectiveIds.includes(stage.id);
                    return (
                      <ToggleButton
                        key={stage.id}
                        value={stage.id}
                        selected={selected}
                        onChange={() => {
                          const current =
                            taskReminderStageIds === null
                              ? defaultIds
                              : taskReminderStageIds;
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
                  });
                })()}
              </Box>
            )}
          </Stack>
        </>
      ) : null}
    </Stack>
  );
}

/**
 * Card-wrapped section for an external converter family (DWG, ebook, etc.).
 * Shows an icon avatar + title + hint subheader so users can scan the
 * "Advanced" tab and immediately tell which subsystem each card belongs
 * to. The original layout was a flat `Stack` of plain text + input rows
 * with the section title floating above — visually flat, hard to scan.
 */
function ConverterCard({
  icon,
  title,
  hint,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <Card variant="outlined" sx={{ borderRadius: 2 }}>
      <CardHeader
        sx={{ pb: 0 }}
        avatar={
          <Avatar
            sx={{
              bgcolor: 'action.hover',
              color: 'text.primary',
              width: 36,
              height: 36,
            }}
          >
            {icon}
          </Avatar>
        }
        title={
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            {title}
          </Typography>
        }
        subheader={
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ mt: 0.5 }}
          >
            {hint}
          </Typography>
        }
      />
      <CardContent sx={{ pt: 1.5 }}>
        <Stack sx={{ gap: 2.5 }}>{children}</Stack>
      </CardContent>
    </Card>
  );
}

/**
 * A single binary-path row inside a `ConverterCard`. Shows the binary's
 * human label, a status chip (detected / not detected, with icon), the
 * optional override TextField, and a small caption that either shows the
 * auto-detected path or notes the custom override.
 *
 * Detected path is hidden from the TextField by design — leaving the field
 * blank means "use the auto-detected one", which is the right behaviour for
 * 99% of installs and avoids the "is this the path I want?" confusion that
 * prefilling the field caused in the original design.
 */
function ConverterRow({
  label,
  hint,
  value,
  detected,
  onChange,
  isLoading,
}: {
  label: string;
  hint: string;
  value: string | null;
  detected: string | null;
  onChange: (v: string | null) => void;
  isLoading?: boolean;
}) {
  const { t } = useTranslation();
  const detectedOk = !!detected;
  const hasOverride = !!value && value !== detected;
  const status = detectedOk
    ? {
        color: 'success' as const,
        icon: <CheckCircleIcon sx={{ fontSize: 16 }} />,
        label: t('converterDetected'),
      }
    : {
        color: 'warning' as const,
        icon: isLoading ? (
          <AutoModeIcon sx={{ fontSize: 16 }} />
        ) : (
          <HelpIcon sx={{ fontSize: 16 }} />
        ),
        label: t('converterNotDetected'),
      };

  return (
    <Box>
      <Stack
        direction="row"
        sx={{ alignItems: 'center', gap: 1, mb: 0.5, flexWrap: 'wrap' }}
      >
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          {label}
        </Typography>
        <Chip
          size="small"
          color={status.color}
          icon={status.icon}
          label={status.label}
        />
        {hasOverride ? (
          <Chip
            size="small"
            variant="outlined"
            color="primary"
            icon={<ErrorIcon sx={{ fontSize: 16 }} />}
            label={t('converterCustomPath')}
          />
        ) : null}
      </Stack>
      <TextField
        size="small"
        fullWidth
        placeholder={t('sofficePathPlaceholder')}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value.trim() || null)}
      />
      <Stack
        direction="row"
        sx={{ alignItems: 'center', gap: 0.5, mt: 0.5 }}
      >
        {detectedOk ? (
          <Tooltip title={detected ?? ''} placement="bottom-start">
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: '100%',
                fontFamily: 'monospace',
                fontSize: '0.7rem',
              }}
            >
              <FolderOpenIcon
                sx={{ fontSize: 12, mr: 0.5, verticalAlign: 'middle' }}
              />
              {t('converterDetectedAt', { path: detected })}
            </Typography>
          </Tooltip>
        ) : hasOverride ? (
          <Typography variant="caption" color="primary.main">
            {t('converterUsingDefault').split('。')[0]}
          </Typography>
        ) : (
          <Typography variant="caption" color="text.secondary">
            {hint}
          </Typography>
        )}
      </Stack>
    </Box>
  );
}

function DwgConverterSection() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const dwg2dxfPath = useSelector(
    (s: RootState) => s.settings?.dwg2dxfPath ?? null
  );
  const odaPath = useSelector((s: RootState) => s.settings?.odaPath ?? null);
  const [detected, setDetected] = useState<{
    dwg2dxf: string | null;
    oda: string | null;
  }>({ dwg2dxf: null, oda: null });
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    ipcApi
      .detectDwgConverters()
      .then((result) => {
        if (!cancelled) setDetected(result);
      })
      .catch(() => {
        if (!cancelled) setDetected({ dwg2dxf: null, oda: null });
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dwg2dxfPath, odaPath]);

  return (
    <ConverterCard
      icon={<ArchitectureIcon />}
      title={t('dwgConverterSection')}
      hint={t('dwgConverterHint')}
    >
      <ConverterRow
        label={t('dwg2dxfPath')}
        hint={t('dwg2dxfPathHint')}
        value={dwg2dxfPath}
        detected={detected.dwg2dxf}
        isLoading={isLoading}
        onChange={(v) => dispatch(setDwg2dxfPath(v))}
      />
      <ConverterRow
        label={t('odaPath')}
        hint={t('odaPathHint')}
        value={odaPath}
        detected={detected.oda}
        isLoading={isLoading}
        onChange={(v) => dispatch(setOdaPath(v))}
      />
    </ConverterCard>
  );
}

function EbookConverterSection() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const calibrePath = useSelector(
    (s: RootState) => s.settings?.calibrePath ?? null
  );
  const [detected, setDetected] = useState<{ calibre: string | null }>({
    calibre: null,
  });
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    ipcApi
      .detectEbookConverter()
      .then((result) => {
        if (!cancelled) setDetected(result);
      })
      .catch(() => {
        if (!cancelled) setDetected({ calibre: null });
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [calibrePath]);

  return (
    <ConverterCard
      icon={<MenuBookIcon />}
      title={t('ebookConverterSection')}
      hint={t('ebookConverterHint')}
    >
      <ConverterRow
        label={t('calibrePath')}
        hint={t('calibrePathHint')}
        value={calibrePath}
        detected={detected.calibre}
        isLoading={isLoading}
        onChange={(v) => dispatch(setCalibrePath(v))}
      />
    </ConverterCard>
  );
}

function AdvancedSection() {
  return (
    <Stack sx={{ gap: 3 }}>
      <ExtensionsSection />
      <FulltextSection />
      <DwgConverterSection />
      <EbookConverterSection />
    </Stack>
  );
}

/**
 * Keyboard shortcut bindings (key → action). Each mappable key gets a row with
 * a dropdown of every available action (plus "None", which clears the binding
 * and restores that key's browser default — notably Tab focus traversal). The
 * bindings take effect in the list/grid file views.
 */
function KeyboardSection() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const keybindings = useSelector(
    (s: RootState) => s.settings?.keybindings
  );

  return (
    <Stack sx={{ gap: 2 }}>
      <Typography variant="body2" color="text.secondary">
        {t('keybindingsHint')}
      </Typography>
      {MAPPABLE_KEYS.map(({ token, labelKey }) => (
        <Field key={token} label={t(labelKey)}>
          <Select<KeyAction>
            value={keybindings?.[token] ?? 'none'}
            onChange={(e) =>
              dispatch(setKeybinding(token, e.target.value as KeyAction))
            }
            size="small"
            sx={{ minWidth: 200 }}
          >
            {KEYBOARD_ACTIONS.map(({ value, labelKey: actionLabelKey }) => (
              <MenuItem key={value} value={value}>
                {t(actionLabelKey)}
              </MenuItem>
            ))}
          </Select>
        </Field>
      ))}
      <Box sx={{ mt: 1 }}>
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

/**
 * Phase 5 — AI assistant. The non-secret config (model, permission, prompts,
 * env) lives in redux; the `ANTHROPIC_API_KEY` is stored encrypted in the main
 * process (safeStorage) and only ever shown here as set / not-set.
 */
function AiSection() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const s = useSelector((state: RootState) => state.settings);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [hasOpenaiKey, setHasOpenaiKey] = useState<boolean | null>(null);
  const [openaiKeyInput, setOpenaiKeyInput] = useState('');
  const [cliFound, setCliFound] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    void ipcApi.aiHasApiKey().then(setHasKey);
    void ipcApi.aiHasOpenaiKey().then(setHasOpenaiKey);
  }, []);

  const discoverCli = () => {
    setCliFound(null);
    void ipcApi.aiDiscoverCli(s.aiCliPath).then((r) => setCliFound(r.path));
  };

  return (
    <Stack sx={{ gap: 2 }}>
      <SectionHeader title={t('aiSettingsTitle')} hint={t('aiSettingsHint')} />

      <AiComponentSection />

      <Field label={t('aiProvider')} hint={t('aiProviderHint')}>
        <Select
          size="small"
          value={s.aiProvider}
          onChange={(e) =>
            dispatch(
              setAiSettings({
                aiProvider: e.target.value as
                  | 'claude-cli'
                  | 'ollama'
                  | 'openai',
              })
            )
          }
        >
          <MenuItem value="claude-cli">{t('aiProviderClaude')}</MenuItem>
          <MenuItem value="ollama">{t('aiProviderOllama')}</MenuItem>
          <MenuItem value="openai">{t('aiProviderOpenai')}</MenuItem>
        </Select>
      </Field>

      {s.aiProvider === 'ollama' ? (
        <Field label={t('aiOllamaUrl')} hint={t('aiOllamaUrlHint')}>
          <TextField
            size="small"
            sx={{ width: 260 }}
            value={s.aiOllamaUrl}
            onChange={(e) =>
              dispatch(setAiSettings({ aiOllamaUrl: e.target.value }))
            }
          />
        </Field>
      ) : null}
      {s.aiProvider === 'openai' ? (
        <>
          <Field label={t('aiOpenaiUrl')} hint={t('aiOpenaiUrlHint')}>
            <TextField
              size="small"
              sx={{ width: 260 }}
              value={s.aiOpenaiUrl}
              onChange={(e) =>
                dispatch(setAiSettings({ aiOpenaiUrl: e.target.value }))
              }
            />
          </Field>
          <Field label={t('aiOpenaiKeyStatus')}>
            <Typography
              variant="caption"
              color={hasOpenaiKey ? 'success.main' : 'text.secondary'}
            >
              {hasOpenaiKey ? t('aiApiKeySet') : t('aiApiKeyNotSet')}
            </Typography>
          </Field>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <TextField
              size="small"
              fullWidth
              type="password"
              placeholder={t('aiOpenaiKeyPlaceholder')}
              value={openaiKeyInput}
              onChange={(e) => setOpenaiKeyInput(e.target.value)}
            />
            <Button
              size="small"
              variant="contained"
              disabled={!openaiKeyInput.trim()}
              onClick={() => {
                void ipcApi.aiSetOpenaiKey(openaiKeyInput).then(() => {
                  setOpenaiKeyInput('');
                  void ipcApi.aiHasOpenaiKey().then(setHasOpenaiKey);
                });
              }}
            >
              {t('aiApiKeySave')}
            </Button>
            <Button
              size="small"
              color="inherit"
              disabled={!hasOpenaiKey}
              onClick={() => {
                void ipcApi.aiClearOpenaiKey().then(() =>
                  void ipcApi.aiHasOpenaiKey().then(setHasOpenaiKey)
                );
              }}
            >
              {t('aiApiKeyClear')}
            </Button>
          </Stack>
        </>
      ) : null}

      {s.aiProvider === 'ollama' || s.aiProvider === 'openai' ? (
        <Field label={t('aiHttpTools')} hint={t('aiHttpToolsHint')}>
          <Switch
            checked={s.aiHttpTools}
            onChange={(e) =>
              dispatch(setAiSettings({ aiHttpTools: e.target.checked }))
            }
          />
        </Field>
      ) : null}

      <Field label={t('aiEnabled')} hint={t('aiEnabledHint')}>
        <Switch
          checked={s.aiEnabled}
          onChange={(e) => dispatch(setAiSettings({ aiEnabled: e.target.checked }))}
        />
      </Field>

      <Field label={t('aiModel')}>
        <Select
          size="small"
          value={s.aiModel}
          onChange={(e) =>
            dispatch(setAiSettings({ aiModel: String(e.target.value) }))
          }
        >
          <MenuItem value="sonnet">Claude Sonnet</MenuItem>
          <MenuItem value="opus">Claude Opus</MenuItem>
          <MenuItem value="haiku">Claude Haiku</MenuItem>
        </Select>
      </Field>

      <Field label={t('aiPermissionMode')} hint={t('aiPermissionModeHint')}>
        <Select
          size="small"
          value={s.aiPermissionMode}
          onChange={(e) =>
            dispatch(
              setAiSettings({
                aiPermissionMode: e.target.value as 'yolo' | 'plan' | 'normal',
              })
            )
          }
        >
          <MenuItem value="yolo">{t('aiPermissionYolo')}</MenuItem>
          <MenuItem value="normal">{t('aiPermissionNormal')}</MenuItem>
          <MenuItem value="plan">{t('aiPermissionPlan')}</MenuItem>
        </Select>
      </Field>

      <Field label={t('aiEffort')}>
        <Select
          size="small"
          value={s.aiEffort}
          onChange={(e) =>
            dispatch(
              setAiSettings({
                aiEffort: e.target.value as 'low' | 'medium' | 'high',
              })
            )
          }
        >
          <MenuItem value="low">{t('aiEffortLow')}</MenuItem>
          <MenuItem value="medium">{t('aiEffortMedium')}</MenuItem>
          <MenuItem value="high">{t('aiEffortHigh')}</MenuItem>
        </Select>
      </Field>

      <Field label={t('aiCliPath')} hint={t('aiCliPathHint')}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Button size="small" variant="outlined" onClick={discoverCli}>
            {t('aiCliDiscover')}
          </Button>
          {cliFound !== undefined ? (
            <Typography variant="caption" color={cliFound ? 'success.main' : 'error.main'}>
              {cliFound ?? t('aiCliNotFound')}
            </Typography>
          ) : null}
        </Stack>
      </Field>
      <TextField
        size="small"
        fullWidth
        placeholder={t('aiCliPathPlaceholder')}
        value={s.aiCliPath ?? ''}
        onChange={(e) =>
          dispatch(setAiSettings({ aiCliPath: e.target.value || null }))
        }
      />

      <Field label={t('aiLoadUserSettings')} hint={t('aiLoadUserSettingsHint')}>
        <Switch
          checked={s.aiLoadUserSettings}
          onChange={(e) =>
            dispatch(setAiSettings({ aiLoadUserSettings: e.target.checked }))
          }
        />
      </Field>

      {s.aiProvider === 'claude-cli' ? (
        <Field label={t('aiAnthropicBaseUrl')} hint={t('aiAnthropicBaseUrlHint')}>
          <TextField
            size="small"
            fullWidth
            placeholder="https://api.example.com"
            value={s.aiAnthropicBaseUrl}
            onChange={(e) =>
              dispatch(setAiSettings({ aiAnthropicBaseUrl: e.target.value }))
            }
          />
        </Field>
      ) : null}

      {s.aiProvider === 'claude-cli' ? (
        <Field label={t('aiAnthropicAuthField')} hint={t('aiAnthropicAuthFieldHint')}>
          <Select
            size="small"
            value={s.aiAnthropicAuthMode}
            onChange={(e) =>
              dispatch(
                setAiSettings({
                  aiAnthropicAuthMode: e.target.value as
                    | 'apiKey'
                    | 'authToken',
                })
              )
            }
          >
            <MenuItem value="apiKey">{t('aiAnthropicAuthApiKey')}</MenuItem>
            <MenuItem value="authToken">{t('aiAnthropicAuthToken')}</MenuItem>
          </Select>
        </Field>
      ) : null}

      <Divider />
      <SectionHeader title={t('aiApiKey')} />
      <Field label={t('aiApiKeyStatus')}>
        <Typography
          variant="caption"
          color={hasKey ? 'success.main' : 'text.secondary'}
        >
          {hasKey ? t('aiApiKeySet') : t('aiApiKeyNotSet')}
        </Typography>
      </Field>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <TextField
          size="small"
          fullWidth
          type="password"
          placeholder={t('aiApiKeyPlaceholder')}
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
        />
        <Button
          size="small"
          variant="contained"
          disabled={!keyInput.trim()}
          onClick={() => {
            void ipcApi.aiSetApiKey(keyInput).then(() => {
              setKeyInput('');
              void ipcApi.aiHasApiKey().then(setHasKey);
            });
          }}
        >
          {t('aiApiKeySave')}
        </Button>
        <Button
          size="small"
          color="inherit"
          disabled={!hasKey}
          onClick={() => {
            void ipcApi.aiClearApiKey().then(() =>
              void ipcApi.aiHasApiKey().then(setHasKey)
            );
          }}
        >
          {t('aiApiKeyClear')}
        </Button>
      </Stack>

      <Divider />
      <SectionHeader title={t('aiSystemPrompt')} />
      <TextField
        size="small"
        fullWidth
        multiline
        minRows={3}
        maxRows={8}
        placeholder={t('aiSystemPromptPlaceholder')}
        value={s.aiCustomSystemPrompt}
        onChange={(e) =>
          dispatch(setAiSettings({ aiCustomSystemPrompt: e.target.value }))
        }
      />

      <SectionHeader title={t('aiEnvOverrides')} hint={t('aiEnvOverridesHint')} />
      <TextField
        size="small"
        fullWidth
        multiline
        minRows={2}
        maxRows={6}
        placeholder={'ANTHROPIC_BASE_URL=...\nHTTP_PROXY=...'}
        value={s.aiEnvVarOverrides}
        onChange={(e) =>
          dispatch(setAiSettings({ aiEnvVarOverrides: e.target.value }))
        }
      />

      {s.aiProvider === 'claude-cli' ? <AiMcpSection /> : null}
    </Stack>
  );
}

/** The left-nav order is the order users see the categories in. Keep stable;
 *  tests reference some IDs (e.g. `data-testid="open-workflow-manager"`). */
const SECTIONS: {
  id: SettingsSectionId;
  labelKey: string;
  Icon: typeof TuneIcon;
}[] = [
  { id: 'general', labelKey: 'settingsSectionGeneral', Icon: TuneIcon },
  { id: 'view', labelKey: 'settingsSectionView', Icon: VisibilityIcon },
  { id: 'keyboard', labelKey: 'settingsSectionKeyboard', Icon: KeyboardIcon },
  { id: 'mapique', labelKey: 'settingsSectionMapique', Icon: MapIcon },
  { id: 'tags', labelKey: 'settingsSectionTags', Icon: StyleIcon },
  {
    id: 'notifications',
    labelKey: 'settingsSectionNotifications',
    Icon: NotificationsIcon,
  },
  { id: 'ai', labelKey: 'settingsSectionAi', Icon: SmartToyIcon },
  { id: 'commands', labelKey: 'settingsSectionCommands', Icon: TerminalIcon },
  { id: 'callouts', labelKey: 'settingsSectionCallouts', Icon: StickyNote2Icon },
  { id: 'about', labelKey: 'settingsSectionAbout', Icon: InfoOutlinedIcon },
  { id: 'advanced', labelKey: 'settingsSectionAdvanced', Icon: SettingsIcon },
];

/**
 * Central settings panel organized by category. The left rail lists the
 * categories; the right pane renders the corresponding section so each pane
 * stays focused and short. Each pane calls into the same Redux `settings`
 * slice — the categories here are UI scaffolding only.
 */
export default function SettingsDialog({
  open,
  section,
  onClose,
}: SettingsDialogProps) {
  const { t } = useTranslation();

  const initialRef = useRef<SettingsSectionId>(section ?? 'general');
  const [active, setActive] = useState<SettingsSectionId>(initialRef.current);

  // Re-focus the requested section each time the dialog re-opens. Without
  // this the user clicking the Sidebar's "Open tag settings" shortcut would
  // still land on whichever tab they last visited.
  useEffect(() => {
    if (open) setActive(section ?? 'general');
  }, [open, section]);

  const [workflowOpen, setWorkflowOpen] = useState(false);

  const renderSection = () => {
    switch (active) {
      case 'general':
        return <GeneralSection />;
      case 'view':
        return <ViewSection />;
      case 'keyboard':
        return <KeyboardSection />;
      case 'mapique':
        return <MapSection />;
      case 'tags':
        return <TagsSection onOpenWorkflowManager={() => setWorkflowOpen(true)} />;
      case 'notifications':
        return <NotificationsSection />;
      case 'ai':
        return <AiSection />;
      case 'commands':
        return <UserCommandsSection />;
      case 'callouts':
        return <CustomCalloutsSection />;
      case 'about':
        return <UpdateSection />;
      case 'advanced':
        return <AdvancedSection />;
      default:
        return null;
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        fullWidth
        maxWidth="md"
        data-testid="settings-dialog"
      >
        <DialogTitle>{t('settings')}</DialogTitle>
        <DialogContent
          dividers
          sx={{ p: 0, overflow: 'hidden' }}
        >
          <Stack
            direction="row"
            sx={{ minHeight: 460, alignItems: 'stretch' }}
          >
            <List
              dense
              sx={{
                width: 200,
                flexShrink: 0,
                borderRight: 1,
                borderColor: 'divider',
                py: 1,
              }}
            >
              {SECTIONS.map(({ id, labelKey, Icon }) => (
                <ListItemButton
                  key={id}
                  selected={active === id}
                  onClick={() => setActive(id)}
                  data-testid={`settings-nav-${id}`}
                  sx={{ px: 1.5 }}
                >
                  <ListItemIcon sx={{ minWidth: 32 }}>
                    <Icon fontSize="small" />
                  </ListItemIcon>
                  <ListItemText
                    primary={t(labelKey)}
                    slotProps={{
                      primary: {
                        variant: 'body2',
                        sx: { fontWeight: 500 },
                      },
                    }}
                  />
                </ListItemButton>
              ))}
            </List>

            <Box
              sx={{
                flex: 1,
                minWidth: 0,
                p: 3,
                overflowY: 'auto',
                maxHeight: 'min(70vh, 640px)',
              }}
            >
              {renderSection()}
            </Box>
          </Stack>
        </DialogContent>
      </Dialog>

      {/* WorkflowManagerDialog is hosted here, not in the Sidebar, so the
        Settings → Tags section acts as the single entry point. */}
      <WorkflowManagerDialog
        open={workflowOpen}
        onClose={() => setWorkflowOpen(false)}
      />
    </>
  );
}
