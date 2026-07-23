import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Chip,
  Divider,
  IconButton,
  Stack,
  TextField,
  Toolbar,
  Tooltip,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import LaunchIcon from '@mui/icons-material/Launch';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import EditNoteIcon from '@mui/icons-material/EditNote';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';

import type { DirEntry } from '../../shared/ipc-types';
import type { SidecarMeta } from '../../shared/whale-meta';
import { RootState } from '-/reducers';
import { setTagColor } from '-/reducers/settings';
import { pickTagColor } from '../domain/tag-colors';
import { useTagMetaContext } from '-/hooks/TagMetaContextProvider';
import { useIOActionsContext } from '-/hooks/IOActionsContextProvider';
import ThumbIcon from '-/components/ThumbIcon';
import InlineTagInput from '-/components/InlineTagInput';
import TagMetaDialog from '-/components/TagMetaDialog';
import { usePeriodTagDialog } from '-/components/PeriodTagDialog';
import { SmartTagChip, StageChip, PeriodChip } from '-/components/QuickTagChips';
import { formatSize, formatDate } from '-/services/format';
import { useDirectoryContent } from '-/hooks/DirectoryContentContextProvider';
import { stripTagsFromName } from '-/services/tags';
import { outlinedTagChipSx, tagDisplayLabel } from '-/services/tag-display';
import { useTagDisplayLabels } from '-/hooks/useTagDisplayLabels';
import {
  SMART_TAGS,
  RATING_TAGS,
  RATING_COLOR,
  QUADRANT_TAGS,
  quadrantColor,
  resolveSmartTag,
  smartTagGlyph,
  smartTagI18nKey,
  withSingleRating,
  withSingleQuadrant,
  withSingleFromValues,
  normalizeSmartTags,
  isAnyDateShapeTag,
  resolveInputTag,
} from '../../shared/smart-tags';
import { useNow } from '-/hooks/useNow';

interface PropertiesTrayProps {
  entries: DirEntry[];
  thumbCache: Map<string, string>;
  readOnly: boolean;
  width: number;
  onClose: () => void;
  onWidthChange: (width: number) => void;
  onOpen: (entry: DirEntry) => void;
  onDelete: (entry: DirEntry) => void;
  /** Failure sink for silent-on-success saves (description blur-save). */
  onError?: (msg: string) => void;
}

const MIN_WIDTH = 260;
const MAX_WIDTH = 600;

/** Apply the per-file save guards (readOnly, dup detection) once, share between
 *  the per-tag add/remove and the smart-tag / rating / workflow / quadrant
 *  quick-add rows so they all stay consistent. Also auto-assigns a color to
 *  freshly added tags (round-robin via pickTagColor) so the chip renders with
 *  its color on the same render instead of flashing the default outlined
 *  look until the TagMetaContextProvider's useEffect catches up. */
function useTagActions({
  entries,
  readOnly,
  tagsByName,
  descByName,
  save,
  saveMany,
}: {
  entries: DirEntry[];
  readOnly: boolean;
  tagsByName: Map<string, string[]>;
  descByName: Map<string, string>;
  save: (entry: DirEntry, meta: SidecarMeta) => Promise<void>;
  saveMany: (updates: { entry: DirEntry; meta: SidecarMeta }[]) => Promise<void>;
}) {
  const dispatch = useDispatch();
  // Phase 3 / freshness: needed by `resolveInputTag` so `today` /
  // `tomorrow` / etc. typed in the chip input resolve to the right
  // concrete value at apply time. Same hook as the tag library uses.
  const now = useNow();
  const tagColors = useSelector(
    (s: RootState) => s.settings?.tagColors ?? {}
  );
  const ensureColored = useCallback(
    (tag: string) => {
      if (!tagColors[tag]) {
        dispatch(setTagColor(tag, pickTagColor(tag, tagColors)));
      }
    },
    [dispatch, tagColors]
  );

  /** Replace the tags of every targeted entry with `nextTags(current)`. */
  const applyToTargets = useCallback(
    async (nextTags: (current: string[]) => string[]) => {
      if (entries.length === 0 || readOnly) return;
      const updates = entries
        .map((entry) => {
          const current = tagsByName.get(entry.path) ?? [];
          const next = nextTags(current);
          if (next === current) return null;
          const description = descByName.get(entry.path);
          return {
            entry,
            meta: {
              tags: next,
              ...(description ? { description } : {}),
            },
          };
        })
        .filter(Boolean) as { entry: DirEntry; meta: SidecarMeta }[];
      if (updates.length === 0) return;
      if (entries.length === 1) {
        // Single: avoid the merge path — saveMany exists but is one IPC round
        // trip less if we go straight to `save` for the common single-file case.
        await save(updates[0].entry, updates[0].meta);
      } else {
        await saveMany(updates);
      }
    },
    [entries, readOnly, tagsByName, descByName, save, saveMany]
  );

  return {
    addTag: (tag: string) => {
      ensureColored(tag);
      return applyToTargets((current) => {
        // Resolve user input through `resolveInputTag`:
        //   - `today` / `tomorrow` / `nextWeek` / etc. → compact `20260704` / ...
        //   - `month-202606` / `today-20260704` → compact `202606` / `20260704`
        //   - `in-progress` / `urgent-important` → unchanged (resolved tokens)
        //   - `vacation` / `idea` → unchanged (plain tags)
        // Then apply互斥 if the resolved tag is in the date family — the
        // date family is互斥 (last-wins) so two date tags in the same file
        // would always collapse to one. The period family互斥 separately.
        const resolved = resolveInputTag(tag, now);
        if (current.includes(resolved)) return current;
        if (isAnyDateShapeTag(resolved)) {
          return normalizeSmartTags([...current, resolved]);
        }
        return [...current, resolved];
      });
    },
    addSmartTag: (tag: string) => {
      ensureColored(tag);
      return applyToTargets((current) =>
        current.includes(tag)
          ? current
          : normalizeSmartTags([...current, tag])
      );
    },
    setRating: (tag: string) => {
      ensureColored(tag);
      return applyToTargets((current) => withSingleRating([...current, tag]));
    },
    setWorkflow: (tag: string, stageValues: string[]) => {
      ensureColored(tag);
      return applyToTargets((current) =>
        withSingleFromValues([...current, tag], stageValues)
      );
    },
    setQuadrant: (tag: string) => {
      ensureColored(tag);
      return applyToTargets((current) => withSingleQuadrant([...current, tag]));
    },
    setPeriod: (period: string) => {
      // Period tag is its own互斥 family — `normalizeSmartTags` collapses
      // any prior period tag on the file to the newly-confirmed one. The
      // dialog (PeriodTagDialog) is opened by the caller; this action only
      // owns the write side, mirroring how `addSmartTag` / `setRating` etc.
      // skip any picker UI.
      ensureColored(period);
      return applyToTargets((current) => {
        if (current.includes(period)) return current;
        return normalizeSmartTags([...current, period]);
      });
    },
    removeTag: (tag: string) =>
      applyToTargets((current) => current.filter((t) => t !== tag)),
  };
}

export default function PropertiesTray({
  entries,
  thumbCache,
  readOnly,
  width,
  onClose,
  onWidthChange,
  onOpen,
  onDelete,
  onError,
}: PropertiesTrayProps) {
  const { t } = useTranslation();
  // H.24 R1: tagsByName/descByName now live on DirectoryContentContext
  // (path-keyed, single source of truth across depth=1 and depth>1).
  const { tagsByName, descByName } = useDirectoryContent();
  const { save, saveMany } = useTagMetaContext();
  // Phase 3 / freshness: `now` is needed by `resolveInputTag` so that
  // `today` / `tomorrow` / etc. resolve to the right concrete value.
  // The hook ticks once a minute; same source as the tag library uses.
  const now = useNow();
  const { renameEntry } = useIOActionsContext();
  const tagColors = useSelector(
    (s: RootState) => s.settings?.tagColors ?? {}
  );
  const tagGroups = useSelector((s: RootState) => s.taglibrary?.groups ?? []);
  const stages = useSelector((s: RootState) => s.workflow?.stages ?? []);
  const stageValues = stages.map((s) => s.value);
  const tagShape = useSelector(
    (s: RootState) => s.settings?.tagShape ?? 'rounded'
  );

  const [desc, setDesc] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState('');
  // Which tag is having its metadata (color + description) edited via the
  // shared TagMetaDialog. Mirrors the right-click flow from TagLibrary so
  // there's one dialog surface for both entry points.
  const [editingTag, setEditingTag] = useState<string | null>(null);
  const resizingRef = useRef<{
    startX: number;
    startWidth: number;
  } | null>(null);

  // Guard against persisted widths from before MIN_WIDTH/MAX_WIDTH existed or
  // any out-of-band state.
  const effectiveWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width));

  const single = entries.length === 1 ? entries[0] : null;

  useEffect(() => {
    if (single) {
      setDesc(descByName.get(single.path) ?? '');
      setRenaming(false);
      setNewName(stripTagsFromName(single.name));
    }
  }, [single, descByName]);

  // Tags shown in the chip row:
  //  - single selection: every tag of that file
  //  - multi-select: only tags shared by every selected file (the bulk edit
  //    surface; per-file-only tags aren't a meaningful common denominator)
  const commonTags = useMemo(() => {
    if (entries.length === 0) return [];
    const tagSets = entries.map((e) => new Set(tagsByName.get(e.path) ?? []));
    return Array.from(tagSets[0]).filter((tag) =>
      tagSets.every((set) => set.has(tag))
    );
  }, [entries, tagsByName]);

  const visibleTags = single
    ? tagsByName.get(single.path) ?? []
    : commonTags;

  // docs/03: freshness-aware chip labels (date-family tags flip on the
  // per-minute tick; subscribed only when a date-shaped tag is present).
  const visibleTagLabels = useTagDisplayLabels(visibleTags);

  const tagActions = useTagActions({
    entries,
    readOnly,
    tagsByName,
    descByName,
    save,
    saveMany,
  });

  // Period tag picker: lives in a global provider (mounted in MainLayout);
  // we just open it and route the confirmed `YYYYMMDD-YYYYMMDD` token back
  // through `tagActions.setPeriod` so互斥 + multi-target saves are uniform
  // with the other quick-add rows.
  const { openDialog: openPeriodDialog } = usePeriodTagDialog();

  const handleSaveDescription = useCallback(async () => {
    if (!single) return;
    const current = descByName.get(single.path) ?? '';
    if (desc.trim() === current.trim()) return;
    try {
      await save(single, { description: desc.trim() });
    } catch (e) {
      // Blur-save is otherwise silent — a failure must surface somewhere
      // (and must not become an unhandled rejection from onBlur).
      onError?.(e instanceof Error ? e.message : String(e));
    }
  }, [single, desc, descByName, save, onError]);

  const handleAddTag = useCallback(
    (tag: string) => {
      void tagActions.addTag(tag);
    },
    [tagActions]
  );

  const handleRemoveTag = useCallback(
    (tag: string) => {
      void tagActions.removeTag(tag);
    },
    [tagActions]
  );

  const handleRenameStart = useCallback(() => {
    if (!single) return;
    setNewName(stripTagsFromName(single.name));
    setRenaming(true);
  }, [single]);

  const handleRenameCommit = useCallback(async () => {
    if (!single || readOnly) return;
    const trimmed = newName.trim();
    if (!trimmed || trimmed === stripTagsFromName(single.name)) {
      setRenaming(false);
      return;
    }
    try {
      await renameEntry(single.path, trimmed);
      setRenaming(false);
    } catch {
      // Error is surfaced by IOActionsContext; reset input on failure.
      setNewName(stripTagsFromName(single.name));
      setRenaming(false);
    }
  }, [single, readOnly, newName, renameEntry]);

  const startResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizingRef.current = {
        startX: e.clientX,
        startWidth: effectiveWidth,
      };

      const onMove = (ev: MouseEvent) => {
        if (!resizingRef.current) return;
        const delta = resizingRef.current.startX - ev.clientX;
        const next = Math.max(
          MIN_WIDTH,
          Math.min(MAX_WIDTH, resizingRef.current.startWidth + delta)
        );
        onWidthChange(next);
      };

      const onUp = () => {
        resizingRef.current = null;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [effectiveWidth, onWidthChange]
  );

  if (entries.length === 0) return null;

  return (
    <Box
      sx={{
        width: effectiveWidth,
        maxWidth: '100%',
        minWidth: 0,
        flexShrink: 0,
        borderLeft: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {/* Resize handle */}
      <Box
        onMouseDown={startResize}
        sx={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 4,
          cursor: 'col-resize',
          zIndex: 1,
          '&:hover': { bgcolor: 'primary.main', opacity: 0.3 },
        }}
      />

      <Toolbar
        variant="dense"
        sx={{
          minHeight: 40,
          borderBottom: 1,
          borderColor: 'divider',
          gap: 1,
          pl: 2,
        }}
      >
        <Typography variant="subtitle2" noWrap sx={{ flex: 1 }}>
          {t('fileProperties')}
        </Typography>
        <Tooltip title={t('close')}>
          <IconButton size="small" onClick={onClose}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Toolbar>

      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', p: 2 }}>
        {single ? (
          <Stack spacing={2}>
            <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
              <Box sx={{ flexShrink: 0, lineHeight: 0 }}>
                <ThumbIcon entry={single} thumbCache={thumbCache} size={48} />
              </Box>
              <Box sx={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
                {renaming ? (
                  <TextField
                    size="small"
                    fullWidth
                    autoFocus
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRenameCommit();
                      if (e.key === 'Escape') {
                        setRenaming(false);
                        setNewName(stripTagsFromName(single.name));
                      }
                    }}
                    onBlur={handleRenameCommit}
                    disabled={readOnly}
                  />
                ) : (
                  <Typography variant="subtitle2" noWrap>
                    {stripTagsFromName(single.name)}
                  </Typography>
                )}
                <Typography variant="caption" color="text.secondary" noWrap>
                  {single.isDirectory ? t('folder') : t('file')}
                </Typography>
              </Box>
              {!renaming && (
                <Tooltip title={t('rename')}>
                  <span>
                    <IconButton
                      size="small"
                      onClick={handleRenameStart}
                      disabled={readOnly}
                    >
                      <EditIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              )}
            </Stack>

            <Stack spacing={0.5}>
              <MetaRow label={t('size')} value={single.isFile ? formatSize(single.size) : '-'} />
              <MetaRow label={t('modified')} value={formatDate(single.modified)} />
              <MetaRow label={t('path')} value={single.path} />
            </Stack>

            <Divider />

            <Box>
              <Typography variant="caption" color="text.secondary">
                {t('tags')}
              </Typography>
              <Box sx={{ mt: 0.5 }}>
                <InlineTagInput
                  tags={visibleTags}
                  tagColors={tagColors}
                  groups={tagGroups}
                  t={t}
                  onAdd={handleAddTag}
                  onRemove={handleRemoveTag}
                  readOnly={readOnly}
                />
              </Box>
            </Box>

            {/* Smart tag quick-add: stamps today/now/yesterday/... on the file.
                Period chip lives in the SAME row as smart tags (it's a
                date-family template too) — same layout as TagGroups.tsx,
                visually distinguished only by its DateRange icon + violet
                accent. Click opens PeriodTagDialog. */}
            {!readOnly && (
              <QuickRow label={t('smartTags')}>
                {SMART_TAGS.map((def) => (
                  <SmartTagChip
                    key={def.functionality}
                    def={def}
                    label={t(smartTagI18nKey(def.functionality))}
                    onClick={() => {
                      const resolved = resolveSmartTag(
                        def.functionality,
                        new Date()
                      );
                      if (resolved) void tagActions.addSmartTag(resolved);
                    }}
                  />
                ))}
                <PeriodChip
                  label={t('tagPeriod')}
                  hint={t('periodHint')}
                  onClick={() =>
                    openPeriodDialog({
                      onConfirm: (period) => {
                        void tagActions.setPeriod(period);
                      },
                    })
                  }
                />
              </QuickRow>
            )}

            {/* Ratings: 1..5 stars. Mutually exclusive — replaces existing rating. */}
            {!readOnly && (
              <QuickRow label={t('ratings')}>
                {RATING_TAGS.map((def) => {
                  const resolved = resolveSmartTag(
                    def.functionality,
                    new Date()
                  );
                  return (
                    <SmartTagChip
                      key={def.functionality}
                      def={def}
                      label={smartTagGlyph(def.functionality) ?? def.title}
                      color={RATING_COLOR}
                      onClick={() => {
                        if (resolved) void tagActions.setRating(resolved);
                      }}
                    />
                  );
                })}
              </QuickRow>
            )}

            {/* Workflow: dynamic stages from the user's settings. */}
            {!readOnly && stages.length > 0 && (
              <QuickRow label={t('workflow')}>
                {stages.map((stage) => (
                  <StageChip
                    key={stage.id}
                    value={stage.value}
                    label={tagDisplayLabel(stage.value, t)}
                    color={tagColors[stage.value] ?? stage.color}
                    onClick={() =>
                      void tagActions.setWorkflow(stage.value, stageValues)
                    }
                  />
                ))}
              </QuickRow>
            )}

            {/* Task quadrant (Eisenhower matrix). Mutually exclusive. */}
            {!readOnly && (
              <QuickRow label={t('quadrant')}>
                {QUADRANT_TAGS.map((def) => {
                  const resolved = resolveSmartTag(
                    def.functionality,
                    new Date()
                  );
                  return (
                    <SmartTagChip
                      key={def.functionality}
                      def={def}
                      label={t(smartTagI18nKey(def.functionality))}
                      color={quadrantColor(def.functionality)}
                      onClick={() => {
                        if (resolved) void tagActions.setQuadrant(resolved);
                      }}
                    />
                  );
                })}
              </QuickRow>
            )}

            
            {/* Per-tag metadata: each chip opens the shared TagMetaDialog
                (color + description in one surface, same as TagLibrary's
                right-click flow). The chip's color reflects the current
                per-tag color so the user can see at a glance which tags
                need editing. */}
            {visibleTags.length > 0 && (
              <Box>
                <Stack
                  direction="row"
                  spacing={0.5}
                  sx={{ alignItems: 'center', mb: 0.5 }}
                >
                  <EditNoteIcon fontSize="small" color="action" />
                  <Typography variant="caption" color="text.secondary">
                    {t('editTag')}
                  </Typography>
                </Stack>
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                  {visibleTags.map((tag, i) => {
                    const c = tagColors[tag];
                    return (
                      <Chip
                        key={tag}
                        label={visibleTagLabels[i]}
                        size="small"
                        variant="outlined"
                        sx={outlinedTagChipSx(c, tagShape)}
                        onClick={() => setEditingTag(tag)}
                      />
                    );
                  })}
                </Box>
              </Box>
            )}

            <Box>
              <Typography variant="caption" color="text.secondary">
                {t('description')}
              </Typography>
              <TextField
                multiline
                fullWidth
                minRows={3}
                maxRows={8}
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                onBlur={handleSaveDescription}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.ctrlKey) {
                    handleSaveDescription();
                  }
                }}
                placeholder={t('noDescription')}
                disabled={readOnly}
                sx={{ mt: 0.5 }}
              />
            </Box>

            <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
              <Tooltip title={t('open')}>
                <IconButton size="small" onClick={() => onOpen(single)}>
                  <LaunchIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title={t('delete')}>
                <span>
                  <IconButton
                    size="small"
                    onClick={() => onDelete(single)}
                    disabled={readOnly}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </Stack>
          </Stack>
        ) : (
          <Stack spacing={2}>
            <Typography variant="subtitle2">
              {t('nSelected', { count: entries.length })}
            </Typography>

            <Box>
              <Typography variant="caption" color="text.secondary">
                {t('tags')}
              </Typography>
              <Box sx={{ mt: 0.5 }}>
                <InlineTagInput
                  tags={commonTags}
                  tagColors={tagColors}
                  groups={tagGroups}
                  t={t}
                  onAdd={handleAddTag}
                  onRemove={handleRemoveTag}
                  readOnly={readOnly}
                />
              </Box>
            </Box>

            {!readOnly && (
              <QuickRow label={t('smartTags')}>
                {SMART_TAGS.map((def) => (
                  <SmartTagChip
                    key={def.functionality}
                    def={def}
                    label={t(smartTagI18nKey(def.functionality))}
                    onClick={() => {
                      const resolved = resolveSmartTag(
                        def.functionality,
                        new Date()
                      );
                      if (resolved) void tagActions.addSmartTag(resolved);
                    }}
                  />
                ))}
                <PeriodChip
                  label={t('tagPeriod')}
                  hint={t('periodHint')}
                  onClick={() =>
                    openPeriodDialog({
                      onConfirm: (period) => {
                        void tagActions.setPeriod(period);
                      },
                    })
                  }
                />
              </QuickRow>
            )}

            {!readOnly && (
              <QuickRow label={t('ratings')}>
                {RATING_TAGS.map((def) => {
                  const resolved = resolveSmartTag(
                    def.functionality,
                    new Date()
                  );
                  return (
                    <SmartTagChip
                      key={def.functionality}
                      def={def}
                      label={smartTagGlyph(def.functionality) ?? def.title}
                      color={RATING_COLOR}
                      onClick={() => {
                        if (resolved) void tagActions.setRating(resolved);
                      }}
                    />
                  );
                })}
              </QuickRow>
            )}

            {!readOnly && stages.length > 0 && (
              <QuickRow label={t('workflow')}>
                {stages.map((stage) => (
                  <StageChip
                    key={stage.id}
                    value={stage.value}
                    label={tagDisplayLabel(stage.value, t)}
                    color={tagColors[stage.value] ?? stage.color}
                    onClick={() =>
                      void tagActions.setWorkflow(stage.value, stageValues)
                    }
                  />
                ))}
              </QuickRow>
            )}

            {!readOnly && (
              <QuickRow label={t('quadrant')}>
                {QUADRANT_TAGS.map((def) => {
                  const resolved = resolveSmartTag(
                    def.functionality,
                    new Date()
                  );
                  return (
                    <SmartTagChip
                      key={def.functionality}
                      def={def}
                      label={t(smartTagI18nKey(def.functionality))}
                      color={quadrantColor(def.functionality)}
                      onClick={() => {
                        if (resolved) void tagActions.setQuadrant(resolved);
                      }}
                    />
                  );
                })}
              </QuickRow>
            )}

            
            <Typography variant="caption" color="text.secondary">
              {t('selectedSummary', {
                folders: entries.filter((e) => e.isDirectory).length,
                files: entries.filter((e) => e.isFile).length,
              })}
            </Typography>
          </Stack>
        )}
      </Box>

      <TagMetaDialog
        open={editingTag !== null}
        tag={editingTag ?? ''}
        onClose={() => setEditingTag(null)}
      />
    </Box>
  );
}

/** Compact label + chip-row used by the smart / rating / workflow / quadrant
 *  quick-add sections. Keeps the visual rhythm of "label : chips" without
 *  each section reimplementing the same Stack/sx. */
function QuickRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Stack
      direction="row"
      sx={{ alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}
    >
      <Typography variant="caption" color="text.secondary">
        {label}:
      </Typography>
      {children}
    </Stack>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ display: 'flex', gap: 1 }}>
      <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
        {label}:
      </Typography>
      <Typography
        variant="caption"
        sx={{
          wordBreak: 'break-all',
          flex: 1,
          fontFamily: 'ui-monospace, monospace',
        }}
      >
        {value}
      </Typography>
    </Box>
  );
}