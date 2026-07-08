import { useState } from 'react';
import { Box, IconButton, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import PendingIcon from '@mui/icons-material/Pending';
import BuildIcon from '@mui/icons-material/Build';

import type { ToolCallInfo } from '../../../shared/ai-types';

const STATUS_ICON = {
  running: <PendingIcon fontSize="small" color="action" />,
  completed: <CheckCircleIcon fontSize="small" color="success" />,
  error: <ErrorIcon fontSize="small" color="error" />,
  blocked: <ErrorIcon fontSize="small" color="warning" />,
} as const;

/** One-line summary of a tool call's primary argument (path/command/pattern). */
function summarize(name: string, input: Record<string, unknown>): string {
  const candidates = ['file_path', 'path', 'notebook_path', 'command', 'pattern', 'url'];
  for (const key of candidates) {
    const v = input[key];
    if (typeof v === 'string' && v) return v;
  }
  return name;
}

/** Collapsible card for a single tool call: name, summary, status, result. */
export default function ToolCall({ call }: { call: ToolCallInfo }) {
  const [open, setOpen] = useState(false);
  const status = STATUS_ICON[call.status];

  return (
    <Box
      sx={{
        my: 0.5,
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        overflow: 'hidden',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 1,
          py: 0.5,
          cursor: 'pointer',
          bgcolor: 'action.hover',
        }}
        onClick={() => setOpen((v) => !v)}
      >
        <BuildIcon fontSize="small" color="action" />
        <Typography variant="caption" sx={{ fontWeight: 'medium' }}>
          {call.name}
        </Typography>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {summarize(call.name, call.input)}
        </Typography>
        {status}
        <IconButton size="small" aria-label="toggle detail">
          <ExpandMoreIcon
            fontSize="small"
            sx={{
              transition: 'transform 0.15s',
              transform: open ? 'rotate(180deg)' : 'none',
            }}
          />
        </IconButton>
      </Box>
      {open ? (
        <Box sx={{ px: 1, py: 0.75, typography: 'body2' }}>
          <Box
            component="pre"
            sx={{
              m: 0,
              mb: call.result ? 0.5 : 0,
              p: 1,
              bgcolor: 'background.default',
              borderRadius: 0.5,
              fontSize: 12,
              overflowX: 'auto',
              whiteSpace: 'pre-wrap',
            }}
          >
            {JSON.stringify(call.input, null, 2)}
          </Box>
          {call.result ? (
            <Box
              component="pre"
              sx={{
                m: 0,
                p: 1,
                bgcolor: 'background.default',
                borderRadius: 0.5,
                fontSize: 12,
                maxHeight: 240,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                color: call.status === 'error' ? 'error.main' : 'text.primary',
              }}
            >
              {call.result}
            </Box>
          ) : null}
          {call.subagent ? (
            <Box sx={{ mt: 0.5, pl: 1, borderLeft: 2, borderColor: 'divider' }}>
              {call.subagent.output ? (
                <Box
                  component="pre"
                  sx={{
                    m: 0,
                    mb: 0.5,
                    p: 0.75,
                    bgcolor: 'background.default',
                    borderRadius: 0.5,
                    fontSize: 12,
                    maxHeight: 160,
                    overflow: 'auto',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {call.subagent.output}
                </Box>
              ) : null}
              {call.subagent.toolCalls.map((nested) => (
                <ToolCall key={nested.id} call={nested} />
              ))}
            </Box>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}
