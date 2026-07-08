// Regression test for the mermaid 11.16 IIFE-wrapper patch applied by
// `scripts/build-extensions.js`.
//
// Background: mermaid's published IIFE bundle (`dist/mermaid.min.js`)
// starts with:
//
//     "use strict";var __esbuild_esm_mermaid_nm;(__esbuild_esm_mermaid_nm||={}).mermaid=(()=>{...})();
//
// and ends with:
//
//     globalThis["mermaid"] = globalThis.__esbuild_esm_mermaid_nm["mermaid"].default;
//
// The middle `var __esbuild_esm_mermaid_nm;` declares an UNDEFINED var,
// so `__esbuild_esm_mermaid_nm || {}` falls through to a throwaway `{}`.
// The IIFE result is assigned to that throwaway, NOT to
// `globalThis.__esbuild_esm_mermaid_nm`. The final line then reads
// `globalThis.__esbuild_esm_mermaid_nm.mermaid.default` and throws
// `Cannot read properties of undefined (reading 'mermaid')`, so
// `window.mermaid` is never assigned and every mermaid render hangs
// (or times out after 8s — see src/extensions/md-editor/md-render.ts).
//
// The build script fixes this by replacing the broken prefix with
// `var __esbuild_esm_mermaid_nm = globalThis.__esbuild_esm_mermaid_nm = {};`
// so the local var and the global reference both point at the same
// object that receives the IIFE export.
//
// This test asserts that the build artifact in
// `release/app/dist/extensions/md-editor/mermaid.min.js` carries the
// patched prefix. If upstream mermaid ships a fix (the broken prefix
// disappears), this test fails and forces a re-verification of the
// build-extensions.js patch branch.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

const DIST_FILE = path.join(
  __dirname,
  '..',
  'release',
  'app',
  'dist',
  'extensions',
  'md-editor',
  'mermaid.min.js'
);

const BROKEN_PREFIX = 'var __esbuild_esm_mermaid_nm;';
const PATCHED_PREFIX =
  'var __esbuild_esm_mermaid_nm = globalThis.__esbuild_esm_mermaid_nm = {};';

describe('mermaid.min.js IIFE-wrapper patch (§18.3.3 mermaid fix)', () => {
  it('dist artifact exists', () => {
    assert.ok(
      existsSync(DIST_FILE),
      `expected build artifact at ${DIST_FILE} — run "npm run build:ext" first`
    );
  });

  it('dist artifact has the patched IIFE wrapper prefix', () => {
    if (!existsSync(DIST_FILE)) return; // skip if dist absent
    const content = readFileSync(DIST_FILE, 'utf8');
    // The IIFE wrapper is preceded by `"use strict";`, so the file's
    // first char is `"`, not `v`. Use `.includes` against the patched
    // prefix — the build script patches in-place via string replace.
    assert.ok(
      content.includes(PATCHED_PREFIX),
      `mermaid.min.js does not contain the patched prefix.\n` +
        `Expected substring: ${JSON.stringify(PATCHED_PREFIX)}\n` +
        `Actual first 200 chars: ${JSON.stringify(content.slice(0, 200))}\n` +
        `Either the build script patch is missing, or upstream mermaid ` +
        `shipped a fix and the patch branch in scripts/build-extensions.js ` +
        `should be removed.`
    );
  });

  it('dist artifact does NOT still carry the broken prefix', () => {
    if (!existsSync(DIST_FILE)) return;
    const content = readFileSync(DIST_FILE, 'utf8');
    assert.equal(
      content.includes(BROKEN_PREFIX),
      false,
      `mermaid.min.js still contains the broken prefix ${JSON.stringify(BROKEN_PREFIX)} — patch did not run or was incomplete.`
    );
  });
});