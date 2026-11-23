import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve(__dirname, 'index.html'), 'utf8');
const css = readFileSync(resolve(__dirname, 'styles.css'), 'utf8');

function relativeLuminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => {
    const ratio = channel / 255;
    return ratio <= 0.04045 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)]
    .sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('mobile document shell', () => {
  it('uses a restrictive CSP and leaves bundle injection to HtmlWebpackPlugin', () => {
    const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/s)?.[1] ?? '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-(?:inline|eval)'/);
    assert.doesNotMatch(html, /<script\b/i);
    assert.doesNotMatch(html, /<(?:iframe|object|embed)\b/i);
    assert.match(html, /width=device-width/);
  });

  it('defines narrow and tablet layouts with safe-area spacing', () => {
    assert.match(css, /@media \(max-width: 480px\)/);
    assert.match(css, /@media \(min-width: 768px\)/);
    assert.match(css, /env\(safe-area-inset-top/);
    assert.match(css, /min-height: 44px/);
  });

  it('prevents iOS focus zoom and keeps 44px touch targets', () => {
    assert.match(
      css,
      /\.mobile-search \.MuiFilledInput-input\s*\{[^}]*font-size:\s*16px/s
    );
    assert.match(
      css,
      /\.tag-strip \.MuiChip-root\s*\{[^}]*min-height:\s*44px/s
    );
    assert.match(
      css,
      /\.view-toggle \.MuiToggleButton-root\s*\{[^}]*min-height:\s*44px/s
    );
    assert.match(
      css,
      /\.clear-filter-control\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px/s
    );
  });

  it('keeps 12px secondary text at WCAG AA contrast', () => {
    const muted = /--mobile-muted:\s*(#[0-9a-f]{6})/i.exec(css)?.[1] ?? '';
    assert.match(muted, /^#[0-9a-f]{6}$/i, 'missing --mobile-muted token');
    for (const background of ['#ffffff', '#f3f6fb']) {
      const ratio = contrastRatio(muted, background);
      assert.ok(
        ratio >= 4.5,
        `--mobile-muted ${muted} on ${background} is ${ratio.toFixed(2)}:1`,
      );
    }
    for (const selector of ['result-count', 'entry-meta', 'preview-kicker', 'preview-meta']) {
      const rule = new RegExp(`\\n\\.${selector}\\s*\\{([^}]*)\\}`, 's').exec(css)?.[1] ?? '';
      assert.match(rule, /color:\s*var\(--mobile-muted\)/, selector);
    }
  });
});
