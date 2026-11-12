/**
 * Renderer boot / global error guard (docs/01 §14).
 *
 * The React error boundary only covers render errors below the root. Failures
 * that happen earlier — a module that throws at import time, a rehydration hang
 * behind `PersistGate`, or an async error outside React — used to leave the
 * window white forever with nothing but a DevTools console line. This guard:
 *
 *  - listens for global `error` / `unhandledrejection` and reports them to main
 *    (which appends to `<userData>/crash.log` through the same path as process
 *    crashes),
 *  - watches the first render (`markReady`) and, if it never happens, shows a
 *    plain-DOM recovery overlay with a Reload button.
 *
 * The overlay deliberately avoids React, MUI, i18n and the store: the thing
 * that failed may be any of them. Everything here is DOM-level and injectable
 * so it can be tested under jsdom.
 */

/** How long the renderer may take to mount before the watchdog fires. */
export const BOOT_WATCHDOG_MS = 15_000;

/** Cap on reports per rolling minute, so an error loop cannot bloat crash.log. */
export const MAX_REPORTS_PER_MINUTE = 20;

const RECOVERY_ID = 'whale-boot-recovery';

/** Human-readable detail for anything a global handler can receive. */
export function errorDetail(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as { stack?: unknown; message?: unknown };
    if (typeof record.stack === 'string' && record.stack) return record.stack;
    if (typeof record.message === 'string') return record.message;
  }
  return String(value);
}

export interface ReportLimiter {
  (detail: string): boolean;
}

/**
 * Sliding-window limiter for crash reports. Returns `true` when the report was
 * accepted. `now` is injectable so tests do not depend on wall-clock time.
 */
export function createReportLimiter(
  now: () => number,
  max = MAX_REPORTS_PER_MINUTE,
  windowMs = 60_000
): ReportLimiter {
  const stamps: number[] = [];
  return () => {
    const at = now();
    while (stamps.length > 0 && at - stamps[0] > windowMs) stamps.shift();
    if (stamps.length >= max) return false;
    stamps.push(at);
    return true;
  };
}

export interface RecoveryScreenOptions {
  title: string;
  detail: string;
  hint?: string;
  onReload?: () => void;
}

/**
 * Show (or update) the recovery overlay. Rendered with plain DOM + inline
 * styles so it works before React/CSS/theme exist. Idempotent by id.
 */
export function showRecoveryOverlay(
  doc: Document,
  options: RecoveryScreenOptions
): HTMLElement {
  let box = doc.getElementById(RECOVERY_ID);
  if (!box) {
    box = doc.createElement('div');
    box.id = RECOVERY_ID;
    box.setAttribute('role', 'alertdialog');
    box.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;display:flex;' +
      'align-items:center;justify-content:center;padding:24px;' +
      'background:#111827;color:#e5e7eb;' +
      'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;';
    doc.body.appendChild(box);
  }

  box.textContent = '';
  const panel = doc.createElement('div');
  panel.style.cssText = 'max-width:720px;width:100%;';

  const title = doc.createElement('h2');
  title.textContent = options.title;
  title.style.cssText = 'margin:0 0 8px;font-size:20px;color:#f9fafb;';

  const hint = doc.createElement('p');
  hint.textContent =
    options.hint ??
    'The interface hit an error before it finished starting. Reload usually recovers; if it keeps happening, the crash log in the app data folder has the details.';
  hint.style.cssText = 'margin:0 0 16px;font-size:14px;color:#9ca3af;';

  const detail = doc.createElement('pre');
  detail.textContent = options.detail;
  detail.style.cssText =
    'margin:0 0 16px;padding:12px;max-height:260px;overflow:auto;' +
    'background:#0b1220;border:1px solid #374151;border-radius:8px;' +
    'font-size:12px;line-height:1.5;color:#fca5a5;' +
    'white-space:pre-wrap;word-break:break-word;';

  const button = doc.createElement('button');
  button.type = 'button';
  button.textContent = 'Reload / 重载';
  button.style.cssText =
    'padding:8px 16px;font-size:14px;border:0;border-radius:6px;' +
    'background:#2563eb;color:#fff;cursor:pointer;';
  button.onclick = () => {
    if (options.onReload) {
      options.onReload();
    } else {
      doc.defaultView?.location.reload();
    }
  };

  panel.append(title, hint, detail, button);
  box.appendChild(panel);
  return box;
}

/** Remove the recovery overlay if it is currently shown. */
export function removeRecoveryOverlay(doc: Document): void {
  doc.getElementById(RECOVERY_ID)?.remove();
}

export interface BootGuardOptions {
  document?: Document;
  window?: Window;
  /** Mount deadline before the watchdog fires (defaults to BOOT_WATCHDOG_MS). */
  watchdogMs?: number;
  /** Receives each accepted report (normally the IPC bridge to main). */
  report?: (detail: string) => void;
  /** Overrides the overlay's Reload action (tests). */
  onReload?: () => void;
}

export interface BootGuard {
  /** Called once the React tree has mounted; cancels the watchdog. */
  markReady(): void;
  /** Remove listeners and the watchdog (tests / hot reload). */
  dispose(): void;
  isReady(): boolean;
}

/**
 * Install the global handlers + boot watchdog. Safe to call before React
 * mounts; `document`/`window` are injectable for jsdom tests.
 */
export function installBootGuard(options: BootGuardOptions = {}): BootGuard {
  const doc = options.document ?? document;
  const win = options.window ?? doc.defaultView ?? window;
  const watchdogMs = options.watchdogMs ?? BOOT_WATCHDOG_MS;
  const allow = createReportLimiter(() => Date.now());
  let ready = false;
  let disposed = false;

  const report = (detail: string): void => {
    if (!allow(detail)) return;
    try {
      options.report?.(detail);
    } catch {
      // Reporting must never break the error path.
    }
  };

  const showRecovery = (title: string, detail: string): void => {
    showRecoveryOverlay(doc, {
      title,
      detail,
      onReload: options.onReload,
    });
  };

  const onError = (event: Event): void => {
    if (disposed) return;
    const errorEvent = event as ErrorEvent;
    const where = errorEvent.filename
      ? ` (${errorEvent.filename}:${errorEvent.lineno ?? 0})`
      : '';
    const detail = `uncaught error${where}: ${errorDetail(
      errorEvent.error ?? errorEvent.message
    )}`;
    report(detail);
    if (!ready) showRecovery('WhaleTag could not start', detail);
  };

  const onRejection = (event: Event): void => {
    if (disposed) return;
    const rejection = event as PromiseRejectionEvent;
    const detail = `unhandled promise rejection: ${errorDetail(
      rejection.reason
    )}`;
    report(detail);
    if (!ready) showRecovery('WhaleTag could not start', detail);
  };

  win.addEventListener('error', onError);
  win.addEventListener('unhandledrejection', onRejection);

  const timer = win.setTimeout(() => {
    if (disposed || ready) return;
    const detail = `startup watchdog: the interface did not become ready within ${watchdogMs} ms`;
    report(detail);
    showRecovery('WhaleTag is taking longer than expected to start', detail);
  }, watchdogMs);

  return {
    isReady: () => ready,
    markReady(): void {
      ready = true;
      win.clearTimeout(timer);
      removeRecoveryOverlay(doc);
    },
    dispose(): void {
      disposed = true;
      win.clearTimeout(timer);
      win.removeEventListener('error', onError);
      win.removeEventListener('unhandledrejection', onRejection);
    },
  };
}
