import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Box, Button, Stack, Typography } from '@mui/material';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional local fallback; omit to keep the root full-window recovery UI. */
  fallback?: ReactNode;
  /** Change after a failure to render the children again. */
  resetKey?: unknown;
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Root-level error boundary. A render error anywhere below would otherwise
 * unmount the whole React tree and leave a blank white window; here we catch it
 * and show a readable message + Reload button instead.
 *
 * The fallback deliberately uses inline styles and no MUI / theme / i18n, so it
 * still renders even when one of those is the thing that crashed.
 */
export default class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to the DevTools console for debugging.
    console.error('Uncaught render error:', error, info.componentStack);

    // Persist the failure next to process crashes so a user-reported blank
    // screen leaves something to diagnose (docs/01 §14). Best-effort only:
    // the bridge or the main process may already be unhealthy.
    try {
      window.whale?.reportRendererError(
        `react error boundary: ${error.stack ?? error.message}\n${
          info.componentStack ?? ''
        }`
      );
    } catch {
      // Diagnostics must never mask the original render error.
    }
    this.props.onError?.(error, info);
  }

  override componentDidUpdate(previousProps: ErrorBoundaryProps): void {
    if (
      this.state.error &&
      !Object.is(previousProps.resetKey, this.props.resetKey)
    ) {
      this.setState({ error: null });
    }
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;

    return (
      <Box
        sx={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          p: 3,
          bgcolor: 'background.default',
          color: 'text.primary',
          zIndex: 9999,
        }}
      >
        <Box sx={{ maxWidth: 640, width: '100%' }}>
          <Typography variant="h6" component="h2" sx={{ mb: 0.5 }}>
            Something went wrong
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            出错了 — 应用渲染时遇到一个错误。
          </Typography>
          <Box
            component="pre"
            sx={{
              bgcolor: 'background.paper',
              border: 1,
              borderColor: 'divider',
              borderRadius: 2,
              p: 1.5,
              m: 0,
              fontSize: 12,
              lineHeight: 1.5,
              color: 'error.main',
              overflow: 'auto',
              maxHeight: 240,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {error.message}
            {error.stack ? `\n\n${error.stack}` : ''}
          </Box>
          <Stack direction="row" sx={{ mt: 2 }}>
            <Button variant="contained" onClick={this.handleReload}>
              Reload / 重载
            </Button>
          </Stack>
        </Box>
      </Box>
    );
  }
}
