import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
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

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to the DevTools console for debugging.
    // eslint-disable-next-line no-console
    console.error('Uncaught render error:', error, info.componentStack);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          background: '#1e1e1e',
          color: '#e5e7eb',
          fontFamily:
            'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
          zIndex: 9999,
        }}
      >
        <div style={{ maxWidth: 640, width: '100%' }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 20 }}>
            Something went wrong
          </h2>
          <p style={{ margin: '0 0 16px', color: '#9ca3af', fontSize: 14 }}>
            出错了 — 应用渲染时遇到一个错误。
          </p>
          <pre
            style={{
              background: '#111827',
              border: '1px solid #374151',
              borderRadius: 8,
              padding: 12,
              fontSize: 12,
              lineHeight: 1.5,
              color: '#f87171',
              overflow: 'auto',
              maxHeight: 240,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {error.message}
            {error.stack ? `\n\n${error.stack}` : ''}
          </pre>
          <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={this.handleReload}
              style={{
                padding: '8px 16px',
                fontSize: 14,
                borderRadius: 6,
                border: 'none',
                background: '#2563eb',
                color: '#fff',
                cursor: 'pointer',
              }}
            >
              Reload / 重载
            </button>
          </div>
        </div>
      </div>
    );
  }
}
