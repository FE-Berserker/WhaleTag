import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Box,
  ButtonBase,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  InputAdornment,
  ListItemButton,
  ListItemIcon,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import SearchIcon from '@mui/icons-material/Search';
import ClearIcon from '@mui/icons-material/Clear';

import McpSection from './McpSection';
import LanSettings from './LanSettings';
import UserCommandsSection from './UserCommandsSection';
import UpdateSection from './UpdateSection';
import WorkflowManagerDialog from './WorkflowManagerDialog';
import {
  NAV_GROUPS,
  SEARCH_ENTRIES,
  SECTION_BY_ID,
  SECTIONS,
  type SettingsSearchEntry,
  type SettingsSectionId,
} from './settings/meta';
import {
  GeneralSection,
  KeyboardSection,
  MapSection,
  NotificationsSection,
  TagsSection,
  ViewSection,
} from './settings/sections';
import { AdvancedSection } from './settings/advanced';
import { SettingsGroup } from './settings/primitives';

export type { SettingsSectionId } from './settings/meta';

export interface SettingsDialogProps {
  open: boolean;
  /** Preselect a section (used by deep links, e.g. the MCP approval flow). */
  section?: SettingsSectionId;
  onClose: () => void;
}

/**
 * Settings dialog shell: fixed-size two-pane layout (grouped navigation +
 * scrollable content). Sections render header-less; this shell owns the page
 * title/description, the searchable navigation and the close affordance.
 */
export default function SettingsDialog({
  open,
  section,
  onClose,
}: SettingsDialogProps) {
  const { t } = useTranslation();
  const [active, setActive] = useState<SettingsSectionId>('general');
  const [query, setQuery] = useState('');
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [highlightAnchor, setHighlightAnchor] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const tabRefs = useRef<Partial<Record<SettingsSectionId, HTMLDivElement | null>>>(
    {}
  );

  // Reset to the requested section whenever the dialog is (re)opened, so deep
  // links and the last-viewed section don't leak into each other.
  useEffect(() => {
    if (!open) return;
    setActive(section ?? 'general');
    setQuery('');
    setHighlightAnchor(null);
  }, [open, section]);

  // Ctrl/Cmd+F focuses the settings search instead of the app's global find.
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const selectTab = useCallback((id: SettingsSectionId) => {
    setActive(id);
    setQuery('');
    if (panelRef.current) panelRef.current.scrollTop = 0;
  }, []);

  const handleNavKeyDown = (event: React.KeyboardEvent) => {
    const current = SECTIONS.findIndex((s) => s.id === active);
    let nextIndex: number | null = null;
    switch (event.key) {
      case 'ArrowDown':
        nextIndex = (current + 1) % SECTIONS.length;
        break;
      case 'ArrowUp':
        nextIndex = (current - 1 + SECTIONS.length) % SECTIONS.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = SECTIONS.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const next = SECTIONS[nextIndex];
    setActive(next.id);
    tabRefs.current[next.id]?.focus();
  };

  const normalizedQuery = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!normalizedQuery) return [];
    const tokens = normalizedQuery.split(/\s+/);
    return SEARCH_ENTRIES.filter((entry) => {
      const haystack = [
        t(entry.titleKey),
        entry.hintKey ? t(entry.hintKey) : '',
        t(SECTION_BY_ID[entry.section].labelKey),
        ...(entry.keywords ?? []),
      ]
        .join(' ')
        .toLowerCase();
      return tokens.every((token) => haystack.includes(token));
    });
  }, [normalizedQuery, t]);

  const groupedResults = useMemo(() => {
    const bySection = new Map<SettingsSectionId, SettingsSearchEntry[]>();
    for (const entry of results) {
      const bucket = bySection.get(entry.section);
      if (bucket) bucket.push(entry);
      else bySection.set(entry.section, [entry]);
    }
    return SECTIONS.filter((s) => bySection.has(s.id)).map(
      (s) => [s, bySection.get(s.id) ?? []] as const
    );
  }, [results]);

  // Timers of the last search jump. Tracked so that a second jump inside the
  // highlight window cancels the first one's cleanup (the first jump's timer
  // used to clear the NEW highlight 1.8 s after the FIRST click), and so
  // closing the dialog cannot fire them into an unmounted tree.
  const jumpTimersRef = useRef<{ scroll?: number; highlight?: number }>({});
  useEffect(
    () => () => {
      window.clearTimeout(jumpTimersRef.current.scroll);
      window.clearTimeout(jumpTimersRef.current.highlight);
    },
    []
  );

  const handleJump = useCallback((entry: SettingsSearchEntry) => {
    setQuery('');
    setActive(entry.section);
    if (panelRef.current) panelRef.current.scrollTop = 0;
    if (!entry.anchor) return;
    const anchor = entry.anchor;
    setHighlightAnchor(anchor);
    window.clearTimeout(jumpTimersRef.current.scroll);
    window.clearTimeout(jumpTimersRef.current.highlight);
    jumpTimersRef.current.scroll = window.setTimeout(() => {
      // Scoped to the settings panel: a document-wide query could match a row
      // of another (not yet unmounted) section.
      panelRef.current
        ?.querySelector<HTMLElement>(`[data-settings-row="${anchor}"]`)
        ?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    }, 40);
    jumpTimersRef.current.highlight = window.setTimeout(
      () => setHighlightAnchor(null),
      1800
    );
  }, []);

  const activeMeta = SECTION_BY_ID[active];

  const renderSection = () => {
    switch (active) {
      case 'general':
        return <GeneralSection />;
      case 'view':
        return <ViewSection />;
      case 'mapique':
        return <MapSection />;
      case 'keyboard':
        return <KeyboardSection />;
      case 'notifications':
        return <NotificationsSection />;
      case 'tags':
        return <TagsSection onOpenWorkflowManager={() => setWorkflowOpen(true)} />;
      case 'mcp':
        return <McpSection />;
      case 'lan':
        return <LanSettings />;
      case 'commands':
        return <UserCommandsSection />;
      case 'advanced':
        return <AdvancedSection />;
      case 'about':
        return <UpdateSection />;
      default:
        return null;
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        data-testid="settings-dialog"
        aria-labelledby="settings-dialog-title"
        fullWidth
        maxWidth={false}
        slotProps={{
          paper: {
            sx: {
              width: 'min(1100px, 94vw)',
              maxWidth: 'min(1100px, 94vw)',
              height: 'min(780px, 88vh)',
              maxHeight: 'min(780px, 88vh)',
              borderRadius: 2,
              overflow: 'hidden',
            },
          },
        }}
      >
        <DialogTitle
          id="settings-dialog-title"
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            px: 3,
            py: 2,
            flexShrink: 0,
          }}
        >
          <Typography component="span" variant="h6" sx={{ fontWeight: 600 }}>
            {t('settings')}
          </Typography>
          <Box sx={{ flex: 1 }} />
          <IconButton
            size="small"
            onClick={onClose}
            aria-label={t('close')}
            sx={{ color: 'text.secondary' }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </DialogTitle>
        <Divider />

        <DialogContent
          sx={{
            p: 0,
            minHeight: 0,
            display: 'flex',
            overflow: 'hidden',
          }}
        >
          <Box
            component="nav"
            sx={{
              width: { xs: 200, sm: 230, md: 260 },
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              borderRight: 1,
              borderColor: 'divider',
              bgcolor: 'background.default',
            }}
          >
            <Box sx={{ p: 1.5, pb: 1 }}>
              <TextField
                inputRef={searchRef}
                data-testid="settings-search"
                size="small"
                fullWidth
                value={query}
                onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    // With text in the box, Escape only clears the search.
                    // The keydown must not reach the Modal root: MUI closes
                    // the whole dialog on `escapeKeyDown`. On an empty box it
                    // is left alone and closes the dialog as usual.
                    if (query === '') return;
                    e.stopPropagation();
                    setQuery('');
                  }
                }}
                placeholder={t('settingsSearchPlaceholder')}
                slotProps={{
                  htmlInput: {
                    'aria-label': t('settingsSearchPlaceholder'),
                  },
                  input: {
                    startAdornment: (
                      <InputAdornment position="start">
                        <SearchIcon sx={{ fontSize: 18 }} />
                      </InputAdornment>
                    ),
                    endAdornment: query ? (
                      <InputAdornment position="end">
                        <IconButton
                          size="small"
                          edge="end"
                          aria-label={t('settingsSearchClear')}
                          onClick={() => {
                            setQuery('');
                            searchRef.current?.focus();
                          }}
                        >
                          <ClearIcon sx={{ fontSize: 16 }} />
                        </IconButton>
                      </InputAdornment>
                    ) : null,
                  },
                }}
              />
            </Box>

            <Box
              role="tablist"
              aria-label={t('settings')}
              aria-orientation="vertical"
              onKeyDown={handleNavKeyDown}
              sx={{
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                pb: 1.5,
              }}
            >
              {NAV_GROUPS.map((group) => (
                <Box key={group.titleKey} role="presentation">
                  <Typography
                    variant="overline"
                    color="text.secondary"
                    sx={{
                      display: 'block',
                      px: 2,
                      pt: 1.5,
                      pb: 0.5,
                      fontSize: 11,
                      lineHeight: 1.6,
                    }}
                  >
                    {t(group.titleKey)}
                  </Typography>
                  {group.ids.map((id) => {
                    const meta = SECTION_BY_ID[id];
                    const Icon = meta.Icon;
                    const isActive = active === id;
                    return (
                      <ListItemButton
                        key={id}
                        id={`settings-tab-${id}`}
                        role="tab"
                        data-testid={`settings-nav-${id}`}
                        aria-selected={isActive}
                        aria-controls="settings-section-panel"
                        tabIndex={isActive ? 0 : -1}
                        selected={isActive}
                        onClick={() => selectTab(id)}
                        ref={(node) => {
                          tabRefs.current[id] = node;
                        }}
                        sx={{
                          mx: 1,
                          px: 1.25,
                          py: 0.5,
                          minHeight: 36,
                          borderRadius: 1,
                          gap: 1,
                          '&.Mui-selected': {
                            bgcolor: 'action.selected',
                            '&:hover': { bgcolor: 'action.selected' },
                          },
                        }}
                      >
                        <ListItemIcon
                          sx={{
                            minWidth: 26,
                            color: isActive ? 'primary.main' : 'text.secondary',
                          }}
                        >
                          <Icon sx={{ fontSize: 18 }} />
                        </ListItemIcon>
                        <Typography
                          variant="body2"
                          noWrap
                          sx={{ fontWeight: isActive ? 600 : 400 }}
                        >
                          {t(meta.labelKey)}
                        </Typography>
                      </ListItemButton>
                    );
                  })}
                </Box>
              ))}
            </Box>
          </Box>

          <Box
            ref={panelRef}
            role="tabpanel"
            id="settings-section-panel"
            aria-labelledby={`settings-tab-${active}`}
            tabIndex={0}
            sx={{
              flex: 1,
              minWidth: 0,
              overflowY: 'auto',
              p: { xs: 2, sm: 3 },
              bgcolor: 'background.paper',
              ...(highlightAnchor
                ? {
                    [`& [data-settings-row="${highlightAnchor}"]`]: {
                      bgcolor: 'action.hover',
                      borderRadius: 1,
                    },
                  }
                : {}),
            }}
          >
            <Box sx={{ maxWidth: 780 }}>
              <Typography
                component="h2"
                variant="h6"
                sx={{ fontWeight: 600, fontSize: 18 }}
              >
                {t(activeMeta.labelKey)}
              </Typography>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ mt: 0.5, mb: 2.5 }}
              >
                {t(activeMeta.descKey)}
              </Typography>

              {normalizedQuery ? (
                <Stack sx={{ gap: 2 }}>
                  <Typography variant="caption" color="text.secondary">
                    {t('settingsSearchResults', { count: results.length })}
                  </Typography>
                  {results.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">
                      {t('settingsSearchEmpty')}
                    </Typography>
                  ) : (
                    groupedResults.map(([meta, entries]) => (
                      <Box key={meta.id}>
                        <Typography
                          variant="overline"
                          color="text.secondary"
                          sx={{ display: 'block', mb: 0.75 }}
                        >
                          {t(meta.labelKey)}
                        </Typography>
                        <SettingsGroup>
                          {entries.map((entry) => (
                            <ButtonBase
                              key={entry.id}
                              onClick={() => handleJump(entry)}
                              sx={{
                                width: '100%',
                                display: 'block',
                                textAlign: 'left',
                                px: 2,
                                py: 1.25,
                              }}
                            >
                              <Typography
                                component="span"
                                variant="body2"
                                sx={{ display: 'block', fontWeight: 500 }}
                              >
                                {t(entry.titleKey)}
                              </Typography>
                              {entry.hintKey ? (
                                <Typography
                                  component="span"
                                  variant="caption"
                                  color="text.secondary"
                                  sx={{ display: 'block', mt: 0.25 }}
                                >
                                  {t(entry.hintKey)}
                                </Typography>
                              ) : null}
                            </ButtonBase>
                          ))}
                        </SettingsGroup>
                      </Box>
                    ))
                  )}
                </Stack>
              ) : (
                renderSection()
              )}
            </Box>
          </Box>
        </DialogContent>
      </Dialog>

      <WorkflowManagerDialog
        open={workflowOpen}
        onClose={() => setWorkflowOpen(false)}
      />
    </>
  );
}
