import { Box, CircularProgress, Typography } from '@mui/material';

interface LoadingOverlayProps {
  /** Localized "loading…" label shown next to the spinner. */
  label: string;
}

/**
 * Centered spinner + label used as the loading state of perspective views
 * (TagCloud / KnowledgeGraph). Fills its flex parent (`flex: 1`). Extracted in
 * H.22 §P2-3 so the three views render an identical loading state.
 */
export default function LoadingOverlay({ label }: LoadingOverlayProps) {
  return (
    <Box
      sx={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
      }}
    >
      <CircularProgress size={20} />
      <Typography color="text.secondary">{label}</Typography>
    </Box>
  );
}
