import { Box, Typography } from '@mui/material';

interface EmptyHintProps {
  /** Localized message explaining why there's nothing to show. */
  message: string;
}

/**
 * Centered secondary-text hint shown when a perspective view has nothing to
 * render (empty directory, or a search/filter that matched nothing). Fills its
 * flex parent. Extracted in H.22 §P2-3 for cross-view consistency.
 */
export default function EmptyHint({ message }: EmptyHintProps) {
  return (
    <Box
      sx={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Typography color="text.secondary">{message}</Typography>
    </Box>
  );
}
