/**
 * H.17 P?: locks down the FileToolbar responsive-folding rules. The component
 * itself is hard to mount in isolation (SearchBar / BreadcrumbNav /
 * ThemeQuickToggle all pull in their own context providers, and jsdom has no
 * real layout so a `ResizeObserver` polyfill + manual trigger would be needed
 * to exercise the width-driven state). Instead we test the pure derivation
 * function `computeFileToolbarVisibility` + the threshold constants — the
 * *only* surface that owns the folding policy.
 *
 * If a future change moves the thresholds or rewires the derivation, the
 * values below will fail loudly. Visual regression of the actual mount
 * (when the AI panel is open at a narrow window) is covered by manual smoke
 * — there's no Playwright suite for the renderer yet.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FOLD_VIEW_DEPTH_BELOW,
  FOLD_CREATE_BUTTONS_BELOW,
  computeFileToolbarVisibility,
} from './FileToolbar';

describe('FileToolbar responsive folding', () => {
  it('exposes the two thresholds in the expected order', () => {
    // viewDepth cluster is the larger of the two (label + 70px slider), so
    // it folds first when the toolbar narrows. create-buttons cluster is
    // smaller (two icon buttons) and folds second.
    assert.ok(
      FOLD_CREATE_BUTTONS_BELOW < FOLD_VIEW_DEPTH_BELOW,
      `create-buttons threshold (${FOLD_CREATE_BUTTONS_BELOW}) should fold later (i.e. at a smaller width) than viewDepth (${FOLD_VIEW_DEPTH_BELOW})`
    );
    // Both thresholds fit between "very narrow" (400) and "comfortable"
    // (900) workspace widths. This is a sanity check against accidental
    // typos that would push the breakpoint out of the practical range.
    assert.ok(
      FOLD_VIEW_DEPTH_BELOW >= 600 && FOLD_VIEW_DEPTH_BELOW <= 900,
      `viewDepth threshold should sit in [600, 900], got ${FOLD_VIEW_DEPTH_BELOW}`
    );
    assert.ok(
      FOLD_CREATE_BUTTONS_BELOW >= 400 && FOLD_CREATE_BUTTONS_BELOW <= 700,
      `create-buttons threshold should sit in [400, 700], got ${FOLD_CREATE_BUTTONS_BELOW}`
    );
  });

  it('shows everything when the workspace is wide', () => {
    assert.deepEqual(computeFileToolbarVisibility(Infinity), {
      showViewDepth: true,
      showCreateButtons: true,
      showMoreMenu: false,
    });
    assert.deepEqual(computeFileToolbarVisibility(1024), {
      showViewDepth: true,
      showCreateButtons: true,
      showMoreMenu: false,
    });
    // At the exact viewDepth threshold, both clusters are still visible.
    assert.deepEqual(computeFileToolbarVisibility(FOLD_VIEW_DEPTH_BELOW), {
      showViewDepth: true,
      showCreateButtons: true,
      showMoreMenu: false,
    });
  });

  it('folds only the viewDepth slider in the medium band', () => {
    // 1px below the viewDepth threshold: viewDepth is hidden, create
    // buttons still inline.
    assert.deepEqual(
      computeFileToolbarVisibility(FOLD_VIEW_DEPTH_BELOW - 1),
      {
        showViewDepth: false,
        showCreateButtons: true,
        showMoreMenu: true,
      }
    );
    // At the create-buttons threshold: still medium (viewDepth hidden,
    // create buttons inline).
    assert.deepEqual(
      computeFileToolbarVisibility(FOLD_CREATE_BUTTONS_BELOW),
      {
        showViewDepth: false,
        showCreateButtons: true,
        showMoreMenu: true,
      }
    );
  });

  it('folds both clusters at narrow widths and shows the ⋮ menu', () => {
    // 1px below the create-buttons threshold: everything folded.
    assert.deepEqual(
      computeFileToolbarVisibility(FOLD_CREATE_BUTTONS_BELOW - 1),
      {
        showViewDepth: false,
        showCreateButtons: false,
        showMoreMenu: true,
      }
    );
    assert.deepEqual(computeFileToolbarVisibility(400), {
      showViewDepth: false,
      showCreateButtons: false,
      showMoreMenu: true,
    });
    // Zero width (e.g. toolbar hidden): fully folded.
    assert.deepEqual(computeFileToolbarVisibility(0), {
      showViewDepth: false,
      showCreateButtons: false,
      showMoreMenu: true,
    });
  });

  it('treats Infinity as the wide initial state (no flash on cold render)', () => {
    // The component seeds `toolbarWidth = Infinity` so the first paint shows
    // every cluster before ResizeObserver fires. A regression that treated
    // Infinity as "unknown / narrow" would flash a folded toolbar on every
    // cold render — this assertion guards that initial state.
    const wide = computeFileToolbarVisibility(Infinity);
    assert.equal(wide.showViewDepth, true);
    assert.equal(wide.showCreateButtons, true);
    assert.equal(wide.showMoreMenu, false);
  });
});
