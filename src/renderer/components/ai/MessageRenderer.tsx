import { Box, Divider, IconButton, Tooltip, Typography } from '@mui/material';
import ReplayIcon from '@mui/icons-material/Replay';

import type { ChatMessage } from '../../../shared/ai-types';
import { renderMarkdown } from './renderMarkdown';
import ThinkingBlock from './ThinkingBlock';
import ToolCall from './ToolCall';

interface MessageRendererProps {
  message: ChatMessage;
  /** If provided, each message shows a hover "rewind" button that drops it and
   *  everything after it from its conversation. */
  onRewind?: (messageId: string) => void;
}

/** Hover-revealed rewind button (top-right of a message). */
function RewindButton({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip title="Rewind to here" placement="left">
      <IconButton
        size="small"
        onClick={onClick}
        sx={{
          position: 'absolute',
          top: -6,
          right: -6,
          opacity: 0,
          transition: 'opacity 0.12s',
          bgcolor: 'background.paper',
          boxShadow: 1,
          '.msg-row:hover &': { opacity: 1 },
        }}
      >
        <ReplayIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}

const markdownSx = {
  typography: 'body2',
  '& p': { my: 0.5 },
  '& pre': {
    p: 1,
    bgcolor: 'action.hover',
    borderRadius: 0.5,
    overflowX: 'auto',
    fontSize: 12,
  },
  '& code': {
    px: 0.4,
    borderRadius: 0.3,
    bgcolor: 'action.hover',
    fontSize: '0.9em',
    fontFamily: 'monospace',
  },
  '& pre code': { bgcolor: 'transparent', px: 0 },
  '& ul, & ol': { pl: 3, my: 0.5 },
  '& a': { color: 'primary.main' },
  '& h1, & h2, & h3, & h4': { mt: 1, mb: 0.5 },
} as const;

/**
 * Render one chat message. User messages are a plain bubble; assistant messages
 * iterate their `contentBlocks` in order (text → markdown, thinking →折叠,
 * tool_use → ToolCall card, context_compacted → divider).
 */
export default function MessageRenderer({ message, onRewind }: MessageRendererProps) {
  if (message.role === 'user') {
    return (
      <Box className="msg-row" sx={{ position: 'relative', alignSelf: 'flex-end', maxWidth: '85%' }}>
        <Box
          sx={{
            px: 1.25,
            py: 0.75,
            borderRadius: 1.5,
            bgcolor: 'primary.main',
            color: 'primary.contrastText',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            typography: 'body2',
          }}
        >
          {message.content}
        </Box>
        {onRewind ? <RewindButton onClick={() => onRewind(message.id)} /> : null}
      </Box>
    );
  }

  const blocks = message.contentBlocks ?? [];
  if (blocks.length === 0 && !message.content) {
    return (
      <Box className="msg-row" sx={{ position: 'relative', alignSelf: 'flex-start', color: 'text.disabled', typography: 'body2' }}>
        …
        {onRewind ? <RewindButton onClick={() => onRewind(message.id)} /> : null}
      </Box>
    );
  }

  return (
    <Box className="msg-row" sx={{ position: 'relative', alignSelf: 'flex-start', width: '100%' }}>
      {onRewind ? <RewindButton onClick={() => onRewind(message.id)} /> : null}
    <Box sx={{ alignSelf: 'flex-start', width: '100%', maxWidth: '100%' }}>
      {blocks.map((block, i) => {
        if (block.type === 'text') {
          return (
            <Box
              key={i}
              sx={{ ...markdownSx }}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(block.content) }}
            />
          );
        }
        if (block.type === 'thinking') {
          return <ThinkingBlock key={i} content={block.content} />;
        }
        if (block.type === 'tool_use') {
          const call = message.toolCalls?.find((t) => t.id === block.toolId);
          if (!call) return null;
          return <ToolCall key={i} call={call} />;
        }
        if (block.type === 'context_compacted') {
          return (
            <Box key={i} sx={{ my: 1 }}>
              <Divider />
              <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
                context compacted
              </Typography>
            </Box>
          );
        }
        return null;
      })}
    </Box>
    </Box>
  );
}
