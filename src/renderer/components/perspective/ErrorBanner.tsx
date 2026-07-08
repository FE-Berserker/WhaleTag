import { Typography } from '@mui/material';

interface ErrorBannerProps {
  /** Localized error text shown above the chart area. */
  message: string;
}

/**
 * Inline error line shown above a perspective view's chart area (e.g. a failed
 * image export). Extracted in H.22 §P2-3 so TagCloud / KnowledgeGraph surface
 * errors identically.
 */
export default function ErrorBanner({ message }: ErrorBannerProps) {
  return (
    <Typography color="error" sx={{ px: 2 }}>
      {message}
    </Typography>
  );
}
