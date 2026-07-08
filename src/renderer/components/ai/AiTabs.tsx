import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import {
  Box,
  IconButton,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import HistoryIcon from '@mui/icons-material/History';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';

import type { RootState } from '-/reducers';
import {
  DEFAULT_CONVERSATION_TITLE,
  closeTab,
  deleteConversation,
  newConversation,
  openConversation,
  setActiveConversation,
} from '-/reducers/ai';

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  }
}

/**
 * Open-conversation tabs + new-tab + history (open/rename/delete). Reads the
 * redux `ai` slice directly; switching tabs just flips `activeId`.
 */
export default function AiTabs() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const conversations = useSelector((s: RootState) => s.ai.conversations);
  const openTabs = useSelector((s: RootState) => s.ai.openTabs);
  const activeId = useSelector((s: RootState) => s.ai.activeId);
  const [historyAnchor, setHistoryAnchor] = useState<HTMLElement | null>(null);

  const title = (id: string) => {
    const c = conversations[id];
    const raw = c?.title && c.title !== DEFAULT_CONVERSATION_TITLE ? c.title : t('aiNewChat');
    return raw.length > 24 ? `${raw.slice(0, 24)}…` : raw;
  };

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.5,
        px: 0.5,
        py: 0.25,
        borderBottom: 1,
        borderColor: 'divider',
        overflowX: 'auto',
        flexShrink: 0,
      }}
    >
      {openTabs.map((id) => (
        <Stack
          key={id}
          direction="row"
          onClick={() => dispatch(setActiveConversation(id))}
          sx={{
            alignItems: 'center',
            gap: 0.25,
            px: 0.75,
            py: 0.25,
            borderRadius: 1,
            cursor: 'pointer',
            maxWidth: 150,
            bgcolor: id === activeId ? 'action.selected' : 'transparent',
            '&:hover': { bgcolor: 'action.hover' },
            flexShrink: 0,
          }}
        >
          <Typography variant="caption" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title(id)}
          </Typography>
          <IconButton
            size="small"
            sx={{ p: 0.25 }}
            onClick={(e) => {
              e.stopPropagation();
              dispatch(closeTab(id));
            }}
          >
            <CloseIcon sx={{ fontSize: 12 }} />
          </IconButton>
        </Stack>
      ))}
      <Tooltip title={t('aiNewChat')}>
        <IconButton size="small" onClick={() => dispatch(newConversation(newId()))}>
          <AddIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Box sx={{ flex: 1 }} />
      <Tooltip title={t('aiHistory')}>
        <IconButton
          size="small"
          onClick={(e) => setHistoryAnchor(e.currentTarget)}
          data-testid="ai-history-button"
        >
          <HistoryIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Menu
        open={historyAnchor !== null}
        onClose={() => setHistoryAnchor(null)}
        anchorEl={historyAnchor ?? undefined}
        slotProps={{ paper: { sx: { minWidth: 220, maxHeight: 360 } } }}
      >
        {Object.values(conversations)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((c) => (
            <MenuItem
              key={c.id}
              onClick={() => {
                dispatch(openConversation(c.id));
                setHistoryAnchor(null);
              }}
              sx={{ alignItems: 'flex-start' }}
            >
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.title && c.title !== DEFAULT_CONVERSATION_TITLE ? c.title : t('aiNewChat')}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {new Date(c.updatedAt).toLocaleString()}
                </Typography>
              </Box>
              <IconButton
                size="small"
                onClick={(e) => {
                  e.stopPropagation();
                  const name =
                    c.title && c.title !== DEFAULT_CONVERSATION_TITLE ? c.title : t('aiNewChat');
                  if (window.confirm(t('aiConfirmDelete', { name }))) {
                    dispatch(deleteConversation(c.id));
                  }
                }}
              >
                <DeleteOutlineIcon fontSize="small" />
              </IconButton>
            </MenuItem>
          ))}
        {Object.keys(conversations).length === 0 ? (
          <MenuItem disabled>{t('aiHistoryEmpty')}</MenuItem>
        ) : null}
      </Menu>
    </Box>
  );
}
