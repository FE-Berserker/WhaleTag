import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfirm } from '-/components/ConfirmDialogProvider';
import { useDispatch, useSelector } from 'react-redux';
import {
  Box,
  IconButton,
  Popover,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import CloseIcon from '@mui/icons-material/Close';
import LabelIcon from '@mui/icons-material/LabelOutlined';
import { useDrag } from 'react-dnd';

import { RootState } from '-/reducers';
import { EMPTY_ARR, EMPTY_OBJ } from '-/constants';
import { setTagColor } from '-/reducers/settings';
import {
  addGroup,
  removeGroup,
  toggleGroup,
  addTagToGroup,
  removeTagFromGroup,
  setGroupColor,
} from '-/reducers/taglibrary';
import { useTagMetaContext } from '-/hooks/TagMetaContextProvider';
import { useLocationTagLibrary } from '-/hooks/LocationTagLibraryContextProvider';
import { DND_TYPE_TAG, type TagDragItem } from '-/services/dnd';
import {
  TAG_PALETTE,
  pickTagColor,
  getTagColor,
  readableTextOn,
} from '../domain/tag-colors';
import {
  SMART_TAGS,
  RATING_TAGS,
  RATING_COLOR,
  QUADRANT_TAGS,
  quadrantColor,
  smartTagGlyph,
  smartTagI18nKey,
} from '../../shared/smart-tags';
import { tagDisplayLabel } from '-/services/tag-display';
import PromptDialog from '-/components/PromptDialog';
import TagMetaDialog from '-/components/TagMetaDialog';
import { SmartTagChip, StageChip, PeriodChip } from '-/components/QuickTagChips';

interface GroupTagProps {
  tag: string;
  color: string | undefined;
  active: boolean;
  description?: string;
  removeTitle: string;
  onToggleActive: (tag: string) => void;
  onEdit: (tag: string) => void;
  onRemove: (tag: string) => void;
}

/** A single predefined tag inside a group — draggable onto a file to apply it. */
function GroupTag({
  tag,
  color,
  active,
  description,
  removeTitle,
  onToggleActive,
  onEdit,
  onRemove,
}: GroupTagProps) {
  const [{ isDragging }, dragRef] = useDrag<
    TagDragItem,
    unknown,
    { isDragging: boolean }
  >(
    () => ({
      type: DND_TYPE_TAG,
      item: { tag },
      collect: (monitor) => ({ isDragging: monitor.isDragging() }),
    }),
    [tag]
  );

  return (
    <Tooltip title={description || tag} disableInteractive>
      <Box
        ref={dragRef}
        onClick={() => onToggleActive(tag)}
        onContextMenu={(e) => {
          e.preventDefault();
          onEdit(tag);
        }}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.25,
          border: 1,
          borderColor: active ? 'primary.main' : 'divider',
          borderRadius: 5,
          px: 0.5,
          py: '1px',
          cursor: 'grab',
          userSelect: 'none',
          fontSize: 11,
          lineHeight: 1.3,
          fontWeight: 500,
          opacity: isDragging ? 0.4 : 1,
          ...(active
            ? { bgcolor: 'primary.main', color: 'common.white' }
            : color
              ? { bgcolor: color, color: readableTextOn(color) }
              : { bgcolor: 'background.paper' }),
        }}
      >
        <Box component="span" sx={{ whiteSpace: 'nowrap' }}>
          {tag}
        </Box>
        <CloseIcon
          onClick={(e) => {
            e.stopPropagation();
            onRemove(tag);
          }}
          titleAccess={removeTitle}
          sx={{ fontSize: 12, opacity: 0.7, cursor: 'pointer', '&:hover': { opacity: 1 } }}
        />
      </Box>
    </Tooltip>
  );
}

/**
 * A built-in smart tag (e.g. "today"). Draggable; resolves to a concrete dated
 * value (e.g. "today-20260627") when dropped on a file. Read-only — not editable.
 *
 * Implementation lives in `QuickTagChips.tsx` so the same component can render
 * the file tray's quick-add rows without duplicating the drag/click wiring.
 */

type DialogState =
  | { mode: 'addGroup' }
  | { mode: 'addTag'; groupId: string }
  | null;

/**
 * Tag Groups: user-defined, persisted collections of reusable tags. Each group
 * is collapsible; its tags are draggable onto files to apply them (reusing the
 * same DnD as the discovered Tag Library). Colors are shared via
 * settings.tagColors.
 */
export default function TagGroups() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const confirm = useConfirm();
  const groups = useSelector(
    (s: RootState) => s.taglibrary?.groups ?? EMPTY_ARR
  );
  const stages = useSelector(
    (s: RootState) => s.workflow?.stages ?? EMPTY_ARR
  );
  const tagColors = useSelector(
    (s: RootState) => s.settings?.tagColors ?? EMPTY_OBJ
  );
  const { descriptions: tagDescriptions } = useLocationTagLibrary();
  const { activeTag, setActiveTag } = useTagMetaContext();

  const [dialog, setDialog] = useState<DialogState>(null);
  const [collapsed, setCollapsed] = useState(false);
  // Which element (a tag or a whole group) is having its color picked.
  const [picking, setPicking] = useState<{ kind: 'group'; id: string } | null>(
    null
  );
  const [colorAnchor, setColorAnchor] = useState<HTMLElement | null>(null);
  // Tag whose metadata (color + description) dialog is open.
  const [editTag, setEditTag] = useState<string | null>(null);

  const startPickingGroup = (id: string, el: HTMLElement) => {
    setPicking({ kind: 'group', id });
    setColorAnchor(el);
  };
  const applyColor = (color: string | null) => {
    if (picking?.kind === 'group') dispatch(setGroupColor(picking.id, color));
    setColorAnchor(null);
    setPicking(null);
  };

  const handlePromptConfirm = (value: string) => {
    if (!dialog) return;
    if (dialog.mode === 'addGroup') {
      dispatch(addGroup(value));
    } else if (dialog.mode === 'addTag') {
      const tag = value.trim();
      dispatch(addTagToGroup(dialog.groupId, tag));
      // Auto-assign a color the first time we see this tag.
      if (tag && !tagColors[tag]) {
        dispatch(setTagColor(tag, pickTagColor(tag, tagColors)));
      }
    }
    setDialog(null);
  };

  const handleRemoveGroup = async (id: string, title: string) => {
    if (
      await confirm({
        message: t('confirmDeleteGroup', { name: title }),
        confirmLabel: t('delete'),
        danger: true,
      })
    ) {
      dispatch(removeGroup(id));
    }
  };

  return (
    <Box
      sx={{
        borderTop: 1,
        borderColor: 'divider',
        maxHeight: 280,
        minHeight: 0,
        overflow: 'auto',
        p: 1,
      }}
    >
      <Stack
        direction="row"
        onClick={() => setCollapsed((c) => !c)}
        sx={{
          alignItems: 'center',
          gap: 0.5,
          mb: collapsed ? 0 : 0.5,
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        {collapsed ? (
          <ChevronRightIcon fontSize="small" sx={{ color: 'text.secondary' }} />
        ) : (
          <ExpandMoreIcon fontSize="small" sx={{ color: 'text.secondary' }} />
        )}
        <LabelIcon fontSize="small" sx={{ color: 'text.secondary' }} />
        <Typography variant="overline" color="text.secondary">
          {t('tagGroups')}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Tooltip title={t('addTagGroup')}>
          <IconButton
            size="small"
            onClick={(e) => {
              e.stopPropagation();
              setDialog({ mode: 'addGroup' });
            }}
          >
            <AddIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      {!collapsed && (
        <>
          <Stack direction="row" sx={{ alignItems: 'center', gap: 0.5, mb: 0.5 }}>
            <Typography variant="caption" color="text.secondary">
              {t('smartTags')}
            </Typography>
          </Stack>
          <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75, mb: 1 }}>
            {SMART_TAGS.map((def) => (
              <SmartTagChip
                key={def.functionality}
                def={def}
                label={t(smartTagI18nKey(def.functionality))}
                hint={t('smartTagsHint')}
              />
            ))}
            {/* Period chip: same row as smart tags (it's a date-family
                template too), but visually distinguished by DateRange icon +
                violet accent. Drags the literal 'period:' payload which
                Row.tsx intercepts to open PeriodTagDialog. */}
            <PeriodChip
              label={t('tagPeriod')}
              hint={t('periodHint')}
            />
          </Stack>

          <Stack direction="row" sx={{ alignItems: 'center', gap: 0.5, mb: 0.5 }}>
            <Typography variant="caption" color="text.secondary">
              {t('ratings')}
            </Typography>
          </Stack>
          <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75, mb: 1 }}>
            {RATING_TAGS.map((def) => (
              <SmartTagChip
                key={def.functionality}
                def={def}
                label={smartTagGlyph(def.functionality) ?? def.title}
                hint={t('ratingsHint')}
                color={RATING_COLOR}
              />
            ))}
          </Stack>

          <Stack direction="row" sx={{ alignItems: 'center', gap: 0.5, mb: 0.5 }}>
            <Typography variant="caption" color="text.secondary">
              {t('workflow')}
            </Typography>
          </Stack>
          <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75, mb: 1 }}>
            {stages.map((stage) => (
              <StageChip
                key={stage.id}
                value={stage.value}
                label={tagDisplayLabel(stage.value, t)}
                hint={t('workflowHint')}
                color={getTagColor(stage.value, tagColors, groups) ?? stage.color}
              />
            ))}
          </Stack>

          <Stack direction="row" sx={{ alignItems: 'center', gap: 0.5, mb: 0.5 }}>
            <Typography variant="caption" color="text.secondary">
              {t('quadrant')}
            </Typography>
          </Stack>
          <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75, mb: 1 }}>
            {QUADRANT_TAGS.map((def) => (
              <SmartTagChip
                key={def.functionality}
                def={def}
                label={t(smartTagI18nKey(def.functionality))}
                hint={t('quadrantHint')}
                color={quadrantColor(def.functionality)}
              />
            ))}
          </Stack>

          {groups.length === 0 ? (
        <Typography variant="caption" color="text.secondary">
          {t('noTagGroups')}
        </Typography>
      ) : (
        groups.map((g) => (
          <Box key={g.id} sx={{ mb: 0.5 }}>
            <Stack
              direction="row"
              sx={{ alignItems: 'center', gap: 0.25 }}
            >
              <IconButton
                size="small"
                onClick={() => dispatch(toggleGroup(g.id))}
                sx={{ p: 0.25 }}
              >
                {g.expanded ? (
                  <ExpandMoreIcon fontSize="small" />
                ) : (
                  <ChevronRightIcon fontSize="small" />
                )}
              </IconButton>
              {/* Group color dot — click to set; member tags inherit it. */}
              <Box
                component="button"
                type="button"
                title={t('clickToColor')}
                onClick={(e) => {
                  e.stopPropagation();
                  startPickingGroup(g.id, e.currentTarget as HTMLElement);
                }}
                sx={{
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  bgcolor: g.color ?? 'action.disabledBackground',
                  border: 1,
                  borderColor: 'divider',
                  cursor: 'pointer',
                  p: 0,
                  flexShrink: 0,
                  '&:hover': { transform: 'scale(1.15)' },
                  transition: 'transform 0.1s',
                }}
              />
              <Typography
                variant="body2"
                sx={{ flex: 1, fontWeight: 500, cursor: 'pointer' }}
                noWrap
                onClick={() => dispatch(toggleGroup(g.id))}
              >
                {g.title}{' '}
                <Typography component="span" variant="caption" color="text.secondary">
                  ({g.tags.length})
                </Typography>
              </Typography>
              <Tooltip title={t('addTag')}>
                <IconButton
                  size="small"
                  onClick={() => setDialog({ mode: 'addTag', groupId: g.id })}
                  sx={{ p: 0.25 }}
                >
                  <AddIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
              <Tooltip title={t('deleteGroup')}>
                <IconButton
                  size="small"
                  onClick={() => handleRemoveGroup(g.id, g.title)}
                  sx={{ p: 0.25 }}
                >
                  <DeleteOutlineIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            </Stack>

            {g.expanded ? (
              <Stack
                direction="row"
                sx={{ flexWrap: 'wrap', gap: 0.75, pl: 1, py: 0.5 }}
              >
                {g.tags.length === 0 ? (
                  <Typography variant="caption" color="text.secondary">
                    {t('emptyGroupHint')}
                  </Typography>
                ) : (
                  g.tags.map((tag) => (
                    <GroupTag
                      key={tag}
                      tag={tag}
                      color={getTagColor(tag, tagColors, groups)}
                      active={activeTag === tag}
                      description={tagDescriptions[tag]}
                      removeTitle={t('removeTag')}
                      onToggleActive={(tg) =>
                        setActiveTag(activeTag === tg ? null : tg)
                      }
                      onEdit={setEditTag}
                      onRemove={(tg) =>
                        dispatch(removeTagFromGroup(g.id, tg))
                      }
                    />
                  ))
                )}
              </Stack>
            ) : null}
          </Box>
        ))
      )}
        </>
      )}

      <PromptDialog
        open={dialog !== null}
        title={dialog?.mode === 'addGroup' ? t('addTagGroup') : t('addTag')}
        label={dialog?.mode === 'addGroup' ? t('groupName') : t('tagName')}
        onConfirm={handlePromptConfirm}
        onClose={() => setDialog(null)}
      />

      <Popover
        open={colorAnchor !== null}
        anchorEl={colorAnchor}
        onClose={() => {
          setColorAnchor(null);
          setPicking(null);
        }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      >
        <Box sx={{ display: 'flex', gap: 0.75, p: 1.5, flexWrap: 'wrap', maxWidth: 240 }}>
          {TAG_PALETTE.map((c) => (
            <Box
              key={c}
              onClick={() => applyColor(c)}
              sx={{
                width: 28,
                height: 28,
                borderRadius: '50%',
                bgcolor: c,
                cursor: 'pointer',
                border: 1,
                borderColor: 'divider',
                '&:hover': { transform: 'scale(1.1)' },
                transition: 'transform 0.1s',
              }}
            />
          ))}
          <Box
            onClick={() => applyColor(null)}
            title={t('clearColor')}
            sx={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              cursor: 'pointer',
              border: 1,
              borderColor: 'divider',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 12,
              color: 'text.secondary',
              '&:hover': { transform: 'scale(1.1)' },
              transition: 'transform 0.1s',
            }}
          >
            ✕
          </Box>
        </Box>
      </Popover>

      {/* Right-click a tag: edit its color + description in one dialog. */}
      <TagMetaDialog
        open={editTag !== null}
        tag={editTag ?? ''}
        onClose={() => setEditTag(null)}
      />
    </Box>
  );
}
