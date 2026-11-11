import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import {
  Box,
  Button,
  Chip,
  Divider,
  FormControl,
  MenuItem,
  Select,
  Stack,
  Switch,
  Typography,
} from '@mui/material';

import { RootState } from '-/reducers';
import { setExtensionEnabled, setDefaultExtension } from '-/reducers/extensions';
import type { ExtensionManifest } from '../../shared/extension-types';

/**
 * Extensions management: enable/disable built-in extensions and choose the
 * default handler for each file type. Only file types with multiple compatible
 * extensions show a default selector.
 */
export default function ExtensionsSection() {
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
