/**
 * md-editor theming — render-theme presets, CodeMirror theme/highlight
 * building, font-size + wrap compartments, and the host `setTheme` bridge.
 * Extracted from index.ts (Phase 2 of the architecture split).
 *
 * md-editor ships render-theme presets (GitHub / Solarized / Dracula / Nord /
 * Gruvbox / One-Dark) INDEPENDENT of WhaleTag's global MUI theme. The host
 * sends `setTheme('light'|'dark')`; we map that to github-light / github-dark
 * unless the user pinned a preset (Settings ▸ General → setMdRenderTheme).
 * `body[data-theme]` carries the preset name; the CSS variable blocks in
 * editor.css key off it. CodeMirror only distinguishes light vs dark, so a
 * preset collapses to that via `presetMode`.
 *
 * Reads/writes the shared `ctx` (mdFontSize, mdWrapMode, mdThemePref, hostMode,
 * view, theme/highlight/fontSize/wrap compartments) + `dom` (wrapStateEl,
 * toggleWrapBtn) from md-context.
 */
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { oneDarkTheme } from '@codemirror/theme-one-dark';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import {
  ctx,
  dom,
  clampFontSize,
  persistMdFontSize,
  persistMdWrapMode,
  type MdRenderPreset,
} from './md-context';
import { detectInitialTheme } from './md-render';
import { T } from './md-i18n';

/** Map a host light/dark mode to the default preset for that mode. */
function presetForMode(mode: 'light' | 'dark'): MdRenderPreset {
  return mode === 'dark' ? 'github-dark' : 'github-light';
}

/**
 * CodeMirror only distinguishes light vs dark; collapse a preset to that.
 * Light presets are the explicit minority (github-light / solarized-light /
 * latex); default to dark so a newly-added preset isn't accidentally rendered
 * with the light CodeMirror theme.
 */
function presetMode(preset: MdRenderPreset): 'light' | 'dark' {
  return preset === 'github-light' ||
    preset === 'solarized-light' ||
    preset === 'latex'
    ? 'light'
    : 'dark';
}

export function applyFontSize(px: number, view: EditorView): void {
  const clamped = clampFontSize(px);
  ctx.mdFontSize = clamped;
  persistMdFontSize(clamped);
  view.dispatch({
    effects: ctx.fontSizeCompartment.reconfigure(
      EditorView.theme({
        '&': { fontSize: `${clamped}px` },
        '.cm-content': { fontSize: `${clamped}px` },
      })
    ),
  });
}

export function applyWrap(mode: 'wrap' | 'nowrap', view: EditorView): void {
  ctx.mdWrapMode = mode;
  persistMdWrapMode(mode);
  view.dispatch({
    effects: ctx.wrapCompartment.reconfigure(
      mode === 'wrap' ? [EditorView.lineWrapping] : []
    ),
  });
  dom.wrapStateEl.textContent = mode === 'wrap' ? T.wrapOn : T.wrapOff;
  dom.toggleWrapBtn.classList.toggle('active', mode === 'wrap');
}

export function themeExtension(theme: 'light' | 'dark'): Extension {
  // Structure only. Token colors come from the dynamic HighlightStyle built by
  // `buildMdHighlightFromCss` (below), not from oneDark's bundled highlight —
  // that way editor tokens follow the render theme. Structure colors (bg /
  // gutters / selection / ...) are further overridden by editor.css
  // `body[data-theme] .cm-*` rules, so oneDarkTheme here just supplies
  // CM-internal defaults (cursor shape, panel layout) we don't otherwise set.
  return theme === 'dark' ? oneDarkTheme : [];
}

/**
 * §editor-theme — build a markdown + code HighlightStyle by reading the ACTIVE
 * render preset's `--md-*` variables off the live DOM via getComputedStyle.
 * Because it reads computed values at call time, the same function serves every
 * preset: call it AFTER `setAttribute('data-theme', …)` so the CSS variables
 * already reflect the new preset, then apply via `ctx.highlightCompartment`.
 *
 * Token mapping reuses the hljs palette where semantics line up (code
 * keyword/string/number/comment) and the base vars for prose: link→accent,
 * quote/url→muted, heading→hljs-title (each preset's "type/function" hue),
 * emphasis/strong→text (they carry styling via italic/bold, not color).
 */
export function buildMdHighlightFromCss(): HighlightStyle {
  const cs = getComputedStyle(document.body);
  const v = (name: string): string => cs.getPropertyValue(name).trim();
  return HighlightStyle.define([
    { tag: tags.heading, color: v('--md-hljs-title') },
    { tag: tags.link, color: v('--md-accent') },
    { tag: tags.url, color: v('--md-muted') },
    { tag: tags.emphasis, color: v('--md-text') },
    { tag: tags.strong, color: v('--md-text') },
    { tag: tags.quote, color: v('--md-muted') },
    { tag: tags.monospace, color: v('--md-hljs-string') },
    { tag: tags.keyword, color: v('--md-hljs-keyword') },
    { tag: tags.atom, color: v('--md-hljs-keyword') },
    { tag: tags.string, color: v('--md-hljs-string') },
    { tag: tags.number, color: v('--md-hljs-number') },
    { tag: tags.comment, color: v('--md-hljs-comment') },
    { tag: tags.meta, color: v('--md-faint') },
  ]);
}

/**
 * Resolve the preset that should be active right now: the user's pinned
 * preset if they chose one from Settings, otherwise the github-light/
 * github-dark preset matching the host's current light/dark mode.
 */
export function resolvePreset(): MdRenderPreset {
  return ctx.mdThemePref === 'auto' ? presetForMode(ctx.hostMode) : ctx.mdThemePref;
}

/**
 * Apply a render-theme preset: set `body[data-theme]` (which swaps the CSS
 * variable block in editor.css) and reconfigure CodeMirror's light/dark
 * theme + dynamic HighlightStyle to match. §settings-sync — theme preset is
 * owned by Settings ▸ General now (the toolbar <select> was removed); the
 * host pushes it via setMdRenderTheme.
 */
export function applyPreset(preset: MdRenderPreset): void {
  document.body.setAttribute('data-theme', preset);
  if (ctx.view) {
    ctx.view.dispatch({
      effects: [
        // data-theme was just set, so buildMdHighlightFromCss reads the new
        // preset's --md-* values — editor tokens follow the render theme.
        ctx.themeCompartment.reconfigure(themeExtension(presetMode(preset))),
        ctx.highlightCompartment.reconfigure(syntaxHighlighting(buildMdHighlightFromCss())),
      ],
    });
  }
}

/**
 * §18.4.4 — apply the host's theme. Accepts `'light' | 'dark' | 'system'`
 * (the host only ever sends light/dark; `'system'` is retained as a
 * defensive fallback and resolves via `detectInitialTheme()`). Records the
 * host mode, then activates the resolved preset — the user's pinned preset
 * if they set one, or the github-light/github-dark preset for the host mode
 * otherwise.
 */
export function applyTheme(theme: 'light' | 'dark' | 'system') {
  let mode: 'light' | 'dark';
  switch (theme) {
    case 'light':
    case 'dark':
      mode = theme;
      break;
    case 'system':
      mode = detectInitialTheme();
      break;
    default:
      // §robust — never throw on an unexpected theme value (a host bug or
      // a future theme shouldn't make the editor unopenable). Fall back to
      // the OS preference and warn. This drops the compile-time
      // exhaustiveness check `assertNever` gave, deliberately — runtime
      // resilience matters more than catching a new union member here.
      // eslint-disable-next-line no-console
      console.warn('[md-editor] unexpected theme, falling back to OS:', theme);
      mode = detectInitialTheme();
  }
  ctx.hostMode = mode;
  applyPreset(resolvePreset());
}

/**
 * §export-theme — read the active render preset's `--md-*` variable values
 * off the live DOM so the exported HTML document carries the same theme.
 * `getComputedStyle(document.body)` resolves each variable to its currently
 * effective value (the :root default OR the body[data-theme='<preset>']
 * override), so this works for every preset without knowing which is active.
 *
 * The list mirrors the 35 names defined in editor.css — keep them in sync if
 * a variable is added/removed.
 */
const MD_VAR_NAMES = [
  '--md-bg', '--md-text', '--md-muted', '--md-faint', '--md-border',
  '--md-accent', '--md-surface', '--md-warn', '--md-hover-bg', '--md-active-bg',
  '--md-splitter-hover', '--md-inline-code-bg', '--md-mark-bg',
  '--md-callout-blue-border', '--md-callout-blue-bg',
  '--md-callout-green-border', '--md-callout-green-bg',
  '--md-callout-orange-border', '--md-callout-orange-bg',
  '--md-callout-red-border', '--md-callout-red-bg',
  '--md-callout-purple-border', '--md-callout-purple-bg',
  '--md-callout-gray-border', '--md-callout-gray-bg',
  '--md-hljs-base', '--md-hljs-comment', '--md-hljs-keyword', '--md-hljs-string',
  '--md-hljs-title', '--md-hljs-number', '--md-hljs-deletion-fg',
  '--md-hljs-deletion-bg', '--md-hljs-addition-fg', '--md-hljs-addition-bg',
] as const;

export function readMdThemeVars(): string {
  const cs = getComputedStyle(document.body);
  return MD_VAR_NAMES.map((n) => `${n}:${cs.getPropertyValue(n).trim()}`).join(';');
}
