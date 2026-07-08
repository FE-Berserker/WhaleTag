import { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItemButton,
  ListItemText,
} from '@mui/material';

import { RootState } from '-/reducers';
import { setTaskReminderStageIds } from '-/reducers/settings';
import { ipcApi } from '-/services/ipc-api';
import { waitForAllowedRoots } from '-/services/allowed-roots';
import { useCurrentLocationContext } from '-/hooks/CurrentLocationContextProvider';
import { joinPath } from '-/services/path-util';
import { getTagColor } from '../../shared/tag-colors';
import { tagDisplayLabel } from '-/services/tag-display';
import {
  buildPendingQuery,
  getDefaultPendingStageIds,
  groupPending,
  type PendingGroup,
} from '../../shared/task-reminder';

/** Parent directory (relative path uses '/'; returns '' for a root-level file). */
function relParentDir(relPath: string): string {
  return relPath.split('/').slice(0, -1).join('/');
}

/**
 * Startup task reminder: when enabled in settings, scans the monitored
 * location's index once on launch for files tagged with a pending workflow
 * status (not-started / in-progress) and lists them in a dialog so the user can
 * jump in and finish them. Mounted inside the location-context providers so it
 * can navigate. No-op (and never renders) when disabled.
 */
export default function TaskReminder() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const { navigateToInLocation } = useCurrentLocationContext();
  const enabled = useSelector(
    (s: RootState) => s.settings?.taskReminderEnabled ?? false
  );
  const locationId = useSelector(
    (s: RootState) => s.settings?.taskReminderLocationId ?? null
  );
  const stageIds = useSelector(
    (s: RootState) => s.settings?.taskReminderStageIds ?? null
  );
  const stages = useSelector((s: RootState) => s.workflow?.stages ?? []);
  const locations = useSelector((s: RootState) => s.locations.items);
  const tagColors = useSelector((s: RootState) => s.settings?.tagColors ?? {});

  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<PendingGroup[]>([]);

  const location = locationId
    ? locations.find((l) => l.id === locationId) ?? null
    : null;

  // Resolve the configured stage IDs to current tag values. If the user has
  // never configured this, compute a sensible default from the current workflow
  // stages and persist it so the setting is explicit going forward.
  const { pendingTags, effectiveStageIds } = useMemo(() => {
    const selectedIds =
      stageIds === null ? getDefaultPendingStageIds(stages) : stageIds;
    const validIds: string[] = [];
    const tagSet = new Set<string>();
    for (const id of selectedIds) {
      const stage = stages.find((s) => s.id === id);
      if (stage) {
        validIds.push(id);
        tagSet.add(stage.value);
      }
    }
    return { pendingTags: Array.from(tagSet), effectiveStageIds: validIds };
  }, [stageIds, stages]);

  // Build a quick value → stage lookup so the chip header can use the stage's
  // own color. Kept as a hook (not inline in render) so it doesn't violate the
  // rules of hooks when the component short-circuits below.
  const stageByValue = useMemo(
    () => new Map(stages.map((s) => [s.value, s] as const)),
    [stages]
  );

  useEffect(() => {
    if (stageIds === null && effectiveStageIds.length > 0) {
      dispatch(setTaskReminderStageIds(effectiveStageIds));
    }
  }, [stageIds, effectiveStageIds, dispatch]);

  // Run once per effective (enabled, location, pending tags) pair after
  // persisted settings have hydrated. In React StrictMode the effect is invoked
  // twice; a plain "ran" ref would block the second invocation and leave the
  // first (cancelled) run as the only attempt, so we rely on dependency changes
  // instead and use a cleanup flag to avoid setting state on an unmounted /
  // stale effect.
  useEffect(() => {
    if (!enabled || !location || pendingTags.length === 0) {
      setGroups([]);
      setOpen(false);
      return;
    }
    const root = location.path;
    let cancelled = false;
    setGroups([]);
    setOpen(false);
    void (async () => {
      try {
        // Wait for Root's `setAllowedRoots` IPC to land before issuing the
        // write-side `index:build` — otherwise the fail-closed empty-roots
        // guard in main refuses it (Refused: no configured locations), the
        // effect's deps don't change, and the reminder silently never runs.
        // Safe no-op when Root has already finished registering.
        await waitForAllowedRoots();
        // Always rebuild the index on startup so the reminder sees the latest
        // sidecar tags (including files in subdirectories). Sidecar writes do not
        // currently incrementally update the SQLite index, so a stale index would
        // make the reminder list inconsistent with reality.
        await ipcApi.buildLocationIndex(root);
        if (cancelled) return;
        const entries = await ipcApi.advancedIndex(root, buildPendingQuery(pendingTags));
        if (cancelled) return;
        const g = groupPending(entries, pendingTags);
        if (g.length > 0) {
          setGroups(g);
          setOpen(true);
        }
      } catch (e) {
        // Best-effort: a missing index or read error must not block startup.
        console.warn('Task reminder check failed:', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, location, pendingTags]);

  if (!open || !location) return null;

  const total = groups.reduce((n, g) => n + g.entries.length, 0);

  const openEntry = (relPath: string) => {
    const parent = relParentDir(relPath);
    const dir = parent ? joinPath(location.path, parent) : location.path;
    navigateToInLocation(location.id, dir);
    setOpen(false);
  };

  return (
    <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
      <DialogTitle>{t('taskReminderTitle', { count: total })}</DialogTitle>
      <DialogContent dividers>
        {(() => {
          let itemIndex = 0;
          return groups.map((g) => {
            const stage = stageByValue.get(g.tag);
            const stageColor =
              stage?.color ??
              getTagColor(g.tag, tagColors, []) ??
              'text.disabled';
            return (
              <Box key={g.tag} sx={{ mb: 1.5 }}>
                <Box
                  sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 0.5,
                    mb: 0.75,
                    px: 1,
                    py: 0.25,
                    borderRadius: 1,
                    bgcolor: stageColor,
                    color: 'common.white',
                    fontSize: 12,
                    fontWeight: 600,
                    textShadow: '0 0 2px rgba(0,0,0,0.6)',
                  }}
                >
                  {tagDisplayLabel(g.tag, t)}
                  <Box component="span" sx={{ opacity: 0.85, ml: 0.25 }}>
                    ({g.entries.length})
                  </Box>
                </Box>
                <List dense disablePadding>
                  {g.entries.map((entry) => {
                    const isFirst = itemIndex === 0;
                    itemIndex += 1;
                    const relPath = entry.path;
                    return (
                      <ListItemButton
                        key={entry.path}
                        autoFocus={isFirst}
                        onClick={() => openEntry(relPath)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            e.stopPropagation();
                            openEntry(relPath);
                          }
                        }}
                        title={t('taskReminderItemHint')}
                        sx={{ borderRadius: 1, py: 0.25 }}
                      >
                        <ListItemText
                          primary={entry.name}
                          secondary={entry.path}
                          slotProps={{
                            primary: { noWrap: true },
                            secondary: { noWrap: true, variant: 'caption' },
                          }}
                        />
                      </ListItemButton>
                    );
                  })}
                </List>
              </Box>
            );
          });
        })()}
      </DialogContent>
      <DialogActions>
        <Button variant="contained" onClick={() => setOpen(false)}>
          {t('gotIt')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
