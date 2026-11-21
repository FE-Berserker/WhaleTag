import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { filmstripPage, filmstripWindow } from './MediaLightbox';

describe('filmstripWindow', () => {
  it('bounds a long playlist to 41 cells around the active item', () => {
    assert.deepEqual(filmstripWindow(100, 50), { start: 30, end: 71 });
  });

  it('shifts the window at either edge instead of leaving the active item out', () => {
    assert.deepEqual(filmstripWindow(100, 0), { start: 0, end: 41 });
    assert.deepEqual(filmstripWindow(100, 99), { start: 59, end: 100 });
    assert.deepEqual(filmstripWindow(100, -10), { start: 0, end: 41 });
    assert.deepEqual(filmstripWindow(100, 1000), { start: 59, end: 100 });
  });

  it('handles short and empty playlists without inventing cells', () => {
    assert.deepEqual(filmstripWindow(3, 1), { start: 0, end: 3 });
    assert.deepEqual(filmstripWindow(0, 0), { start: 0, end: 0 });
  });

  it('supports a zero-radius window for a single active cell', () => {
    assert.deepEqual(filmstripWindow(10, 4, 0), { start: 4, end: 5 });
  });
});

describe('filmstripPage', () => {
  it('pages directly to remote cells while retaining the 41-cell bound', () => {
    assert.deepEqual(filmstripPage(100, 41), { start: 41, end: 82 });
    assert.deepEqual(filmstripPage(100, 82), { start: 59, end: 100 });
  });

  it('clamps previous/next paging at playlist boundaries', () => {
    assert.deepEqual(filmstripPage(100, -41), { start: 0, end: 41 });
    assert.deepEqual(filmstripPage(3, 99), { start: 0, end: 3 });
    assert.deepEqual(filmstripPage(0, 0), { start: 0, end: 0 });
  });
});
