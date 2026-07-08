import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { IconButton, Tooltip } from '@mui/material';
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

import { RootState } from '-/reducers';
import { setThemeMode, setThemePreset, type ThemeMode } from '-/reducers/settings';
import { THEME_MODE_PRESET_MAP } from '-/theme/presets';

const ORDER: ThemeMode[] = [
  'light',
  'dark',
  'system',
  'warm-paper',
  'midnight-plum',
  'frosted-mint',
  'deep-ocean',
  'dawn-blush',
  'forest-ink',
  'soft-amber',
  'high-contrast',
];

const THEME_ICONS: Record<ThemeMode, typeof Brightness7Icon> = {
  light: Brightness7Icon,
  dark: Brightness4Icon,
  system: SettingsBrightnessIcon,
  'warm-paper': WbSunnyIcon,
  'midnight-plum': NightsStayIcon,
  'frosted-mint': AcUnitIcon,
  'deep-ocean': WaterDropIcon,
  'dawn-blush': WbTwilightIcon,
  'forest-ink': ParkIcon,
  'soft-amber': WbSunnyIcon,
  'high-contrast': ContrastIcon,
};

const THEME_TOOLTIP_KEYS: Record<ThemeMode, string> = {
  light: 'switchToLight',
  dark: 'switchToDark',
  system: 'switchToSystem',
  'warm-paper': 'presetWarmPaper',
  'midnight-plum': 'presetMidnightPlum',
  'frosted-mint': 'presetFrostedMint',
  'deep-ocean': 'presetDeepOcean',
  'dawn-blush': 'presetDawnBlush',
  'forest-ink': 'presetForestInk',
  'soft-amber': 'presetSoftAmber',
  'high-contrast': 'presetHighContrast',
};

/**
 * One-click theme cycler for the file toolbar. Each click advances through the
 * eleven available theme modes, so the most common switches never need opening
 * Settings. The icon reflects the *current* state; the tooltip names the *next*
 * state. The full picker lives in Settings → General.
 */
export default function ThemeQuickToggle() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const themeMode = useSelector((s: RootState) => s.settings.themeMode);

  const currentIdx = ORDER.indexOf(themeMode);
  const current: ThemeMode = currentIdx === -1 ? 'light' : ORDER[currentIdx];
  const next: ThemeMode = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];

  const Icon = THEME_ICONS[current];
  const tooltip = t(THEME_TOOLTIP_KEYS[next]);

  return (
    <Tooltip title={tooltip}>
      <IconButton
        size="small"
        onClick={() => {
          dispatch(setThemeMode(next));
          // Keep themePreset in sync for backward compatibility.
          const preset =
            THEME_MODE_PRESET_MAP[next as keyof typeof THEME_MODE_PRESET_MAP];
          if (preset) dispatch(setThemePreset(preset.presetId));
        }}
        data-testid="theme-quick-toggle"
        aria-label={tooltip}
      >
        <Icon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}
