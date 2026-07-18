import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Menu,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import AddIcon from '@mui/icons-material/Add';

import { RootState } from '-/reducers';
import {
  addStage,
  removeStage,
  renameStage,
  setStageColor,
  moveStage,
  toStageToken,
} from '-/reducers/workflow';
import { setTagColor, setTagShape } from '-/reducers/settings';
import {
  TAG_PALETTE,
  readableTextOn,
  tagShapeSx,
  tagShapeBoxPadding,
  TAG_SHAPES,
} from '../domain/tag-colors';
import { tagDisplayLabel } from '-/services/tag-display';
import type { WorkflowStage } from '../domain/workflow';

interface WorkflowManagerDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Manages the customizable workflow stages that drive the Kanban columns and the
 * workflow chips in the tag library/editor. Each stage = a tag token + a color +
 * an order. Stage colors are mirrored into settings.tagColors so getTagColor
 * resolves them everywhere. Renaming changes the stored token; files already
 * tagged with the old token are not migrated (they fall under "Untagged").
 */
export default function WorkflowManagerDialog({
  open,
  onClose,
}: WorkflowManagerDialogProps) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const stages = useSelector((s: RootState) => s.workflow?.stages ?? []);
  const tagShape = useSelector((s: RootState) => s.settings?.tagShape ?? 'rounded');

  const [newName, setNewName] = useState('');
  // Palette popover: which stage's color is being edited, and its anchor.
  const [palette, setPalette] = useState<{
    anchorEl: HTMLElement;
    stage: WorkflowStage;
  } | null>(null);

  const commitRename = (stage: WorkflowStage, raw: string) => {
    // The field shows the localized label (e.g. "进行中"); only rename when the
    // user actually changed it, so editing the default stages doesn't replace
    // their token with the localized string.
    if (raw.trim() === tagDisplayLabel(stage.value, t)) return;
    const token = toStageToken(raw);
    if (!token || token === stage.value) return;
    dispatch(renameStage(stage.id, token));
    // Carry the stage's color onto the new token so chips/columns stay colored.
    dispatch(setTagColor(token, stage.color));
  };

  const pickColor = (color: string) => {
    if (!palette) return;
    dispatch(setStageColor(palette.stage.id, color));
    dispatch(setTagColor(palette.stage.value, color));
    setPalette(null);
  };

  const handleAdd = () => {
    const token = toStageToken(newName);
    if (!token) return;
    // Seed the new stage with the least-used palette color.
    const used = new Set(stages.map((s) => s.color));
    const color = TAG_PALETTE.find((c) => !used.has(c)) ?? TAG_PALETTE[0];
    dispatch(addStage(token, color));
    dispatch(setTagColor(token, color));
    setNewName('');
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{t('tagManagement')}</DialogTitle>
      <DialogContent>
        {/* Global tag-chip shape — applies to every tag chip in the app. */}
        <Typography variant="caption" color="text.secondary">
          {t('tagShape')}
        </Typography>
        <Box sx={{ display: 'flex', gap: 1, mt: 0.5, mb: 2, flexWrap: 'wrap' }}>
          {TAG_SHAPES.map((shape) => {
            const selected = tagShape === shape;
            return (
              <Box
                key={shape}
                onClick={() => dispatch(setTagShape(shape))}
                title={t(`shape_${shape}`)}
                sx={{
                  px: 1.25,
                  py: 0.5,
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: 'pointer',
                  color: selected ? 'common.white' : 'text.primary',
                  bgcolor: selected ? 'primary.main' : 'action.selected',
                  border: 1,
                  borderColor: selected ? 'primary.main' : 'divider',
                  ...tagShapeSx(shape),
                  ...tagShapeBoxPadding(shape),
                }}
              >
                {t(`shape_${shape}`)}
              </Box>
            );
          })}
        </Box>

        <Typography variant="caption" color="text.secondary">
          {t('workflowStages')}
        </Typography>

        <Stack spacing={1} sx={{ mt: 1 }}>
          {stages.map((stage, i) => (
            <Box
              key={stage.id}
              sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}
            >
              <Tooltip title={t('changeColor')}>
                <Box
                  onClick={(e) =>
                    setPalette({ anchorEl: e.currentTarget, stage })
                  }
                  sx={{
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    bgcolor: stage.color,
                    cursor: 'pointer',
                    flexShrink: 0,
                    border: 1,
                    borderColor: 'divider',
                    '&:hover': { transform: 'scale(1.1)' },
                    transition: 'transform 0.1s',
                  }}
                />
              </Tooltip>
              <TextField
                size="small"
                defaultValue={tagDisplayLabel(stage.value, t)}
                key={`${stage.id}:${stage.value}`}
                onBlur={(e) => commitRename(stage, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
                sx={{ flex: 1 }}
              />
              <Tooltip title={t('moveUp')}>
                <span>
                  <IconButton
                    size="small"
                    disabled={i === 0}
                    onClick={() => dispatch(moveStage(stage.id, -1))}
                  >
                    <ArrowUpwardIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title={t('moveDown')}>
                <span>
                  <IconButton
                    size="small"
                    disabled={i === stages.length - 1}
                    onClick={() => dispatch(moveStage(stage.id, 1))}
                  >
                    <ArrowDownwardIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title={t('removeStage')}>
                <IconButton
                  size="small"
                  onClick={() => dispatch(removeStage(stage.id))}
                >
                  <DeleteOutlineIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
          ))}
        </Stack>

        {/* Add a new stage */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 2 }}>
          <TextField
            size="small"
            placeholder={t('stageName')}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAdd();
            }}
            sx={{ flex: 1 }}
          />
          <Button
            variant="outlined"
            startIcon={<AddIcon />}
            onClick={handleAdd}
            disabled={!toStageToken(newName)}
          >
            {t('addStage')}
          </Button>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button variant="contained" onClick={onClose}>
          {t('close')}
        </Button>
      </DialogActions>

      {/* Per-stage color palette popover */}
      <Menu
        open={palette !== null}
        anchorEl={palette?.anchorEl ?? null}
        onClose={() => setPalette(null)}
      >
        <Box
          sx={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 0.75,
            p: 1,
            maxWidth: 200,
          }}
        >
          {TAG_PALETTE.map((c) => (
            <Box
              key={c}
              onClick={() => pickColor(c)}
              sx={{
                width: 24,
                height: 24,
                borderRadius: '50%',
                bgcolor: c,
                cursor: 'pointer',
                border: palette?.stage.color === c ? 2 : 1,
                borderColor:
                  palette?.stage.color === c ? 'text.primary' : 'divider',
                color: readableTextOn(c),
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 13,
                fontWeight: 700,
                '&:hover': { transform: 'scale(1.1)' },
                transition: 'transform 0.1s',
              }}
            >
              {palette?.stage.color === c ? '✓' : ''}
            </Box>
          ))}
        </Box>
      </Menu>
    </Dialog>
  );
}
