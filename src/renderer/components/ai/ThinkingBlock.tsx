import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Box, IconButton, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import PsychologyIcon from '@mui/icons-material/Psychology';

import { renderMarkdown } from './renderMarkdown';

/** Collapsible "thinking" reasoning block, collapsed by default. */
export default function ThinkingBlock({ content }: { content: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <Box sx={{ my: 0.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <IconButton
          size="small"
          onClick={() => setOpen((v) => !v)}
          aria-label={t('aiThinking')}
        >
          <PsychologyIcon fontSize="small" color="action" />
          <ExpandMoreIcon
            fontSize="small"
            sx={{
              transition: 'transform 0.15s',
              transform: open ? 'rotate(180deg)' : 'none',
            }}
          />
        </IconButton>
        <Typography variant="caption" color="text.secondary">
          {t('aiThinking')}
        </Typography>
      </Box>
      {open ? (
        <Box
          sx={{
            pl: 5,
            color: 'text.secondary',
            borderLeft: 2,
            borderColor: 'divider',
            typography: 'body2',
            '& p': { my: 0.5 },
          }}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
        />
      ) : null}
    </Box>
  );
}
