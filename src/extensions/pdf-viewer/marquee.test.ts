import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  rectFromPoints,
  spansInRect,
  spansToText,
  type SpanBox,
} from './marquee';

const span = (
  left: number,
  top: number,
  width: number,
  height: number,
  text: string
): SpanBox => ({ left, top, width, height, text });

describe('rectFromPoints', () => {
  it('normalizes any drag direction into a top-left-anchored rect', () => {
    assert.deepEqual(rectFromPoints(10, 20, 40, 60), {
      left: 10,
      top: 20,
      width: 30,
      height: 40,
    });
    // Reverse drag (bottom-right → top-left) gives the same rect.
    assert.deepEqual(rectFromPoints(40, 60, 10, 20), {
      left: 10,
      top: 20,
      width: 30,
      height: 40,
    });
  });
});

describe('spansInRect', () => {
  const spans = [
    span(10, 10, 40, 10, 'alpha'),
    span(100, 10, 40, 10, 'beta'),
    span(10, 100, 40, 10, 'gamma'),
  ];

  it('keeps only spans intersecting the rect', () => {
    const hits = spansInRect(spans, {
      left: 0,
      top: 0,
      width: 60,
      height: 60,
    });
    assert.deepEqual(
      hits.map((s) => s.text),
      ['alpha']
    );
  });

  it('counts edge overlap as a hit and fully-outside as a miss', () => {
    const hits = spansInRect(spans, {
      left: 45,
      top: 5,
      width: 10,
      height: 10,
    });
    assert.deepEqual(
      hits.map((s) => s.text),
      ['alpha']
    );
  });

  it('returns [] for an empty marquee / empty page', () => {
    assert.equal(spansInRect(spans, { left: 500, top: 500, width: 10, height: 10 }).length, 0);
    assert.equal(spansInRect([], { left: 0, top: 0, width: 10, height: 10 }).length, 0);
  });
});

describe('spansToText', () => {
  it('joins spans on the same line in left order with spaces', () => {
    const text = spansToText([
      span(60, 10, 30, 10, 'world'),
      span(10, 10, 40, 10, 'hello'),
    ]);
    assert.equal(text, 'hello world');
  });

  it('splits lines by top proximity and joins with newline', () => {
    const text = spansToText([
      span(10, 10, 40, 10, 'first'),
      span(10, 24, 40, 10, 'second'),
      span(10, 100, 40, 10, 'third'),
    ]);
    assert.equal(text, 'first\nsecond\nthird');
  });

  it('groups same-line spans split mid-word by pdfjs', () => {
    const text = spansToText([
      span(10, 10, 20, 10, 'Whale'),
      span(32, 10, 18, 10, 'Tag'),
      span(10, 30, 38, 10, 'PDF'),
    ]);
    assert.equal(text, 'Whale Tag\nPDF');
  });

  it('returns empty string for no spans and drops blank lines', () => {
    assert.equal(spansToText([]), '');
    assert.equal(spansToText([span(0, 0, 5, 10, '   ')]), '');
  });
});
