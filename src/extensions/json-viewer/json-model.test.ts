/**
 * Unit tests for the json-viewer pure helpers. Run under `node:test` via the
 * repo's existing `npm test` script (registered in package.json alongside the
 * other extension tests, e.g. image-viewer/keymap.test.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeStats,
  formatPath,
  isSimpleKey,
  isContainer,
  summarize,
  toPretty,
  toMinified,
} from './json-model';

describe('isContainer', () => {
  it('is true for objects and arrays, false otherwise', () => {
    assert.equal(isContainer({}), true);
    assert.equal(isContainer([]), true);
    assert.equal(isContainer(null), false);
    assert.equal(isContainer('x'), false);
    assert.equal(isContainer(3), false);
    assert.equal(isContainer(false), false);
  });
});

describe('computeStats', () => {
  it('counts a lone primitive as one node at depth 1', () => {
    assert.deepEqual(computeStats(42), { nodes: 1, depth: 1 });
  });

  it('counts nested containers and tracks max depth', () => {
    // root(1) + a(2) + a.b(3) + a.b[0](4) + a.b[1](4)
    const stats = computeStats({ a: { b: [1, 2] } });
    assert.equal(stats.nodes, 5);
    assert.equal(stats.depth, 4);
  });

  it('handles empty containers', () => {
    assert.deepEqual(computeStats({}), { nodes: 1, depth: 1 });
    assert.deepEqual(computeStats([]), { nodes: 1, depth: 1 });
  });
});

describe('isSimpleKey', () => {
  it('accepts identifier-like keys', () => {
    assert.equal(isSimpleKey('name'), true);
    assert.equal(isSimpleKey('_id'), true);
    assert.equal(isSimpleKey('$ref'), true);
    assert.equal(isSimpleKey('a1'), true);
  });

  it('rejects keys needing bracket notation', () => {
    assert.equal(isSimpleKey('odd key'), false);
    assert.equal(isSimpleKey('1abc'), false);
    assert.equal(isSimpleKey('a.b'), false);
    assert.equal(isSimpleKey(''), false);
  });
});

describe('formatPath', () => {
  it('returns $ for the root', () => {
    assert.equal(formatPath([]), '$');
  });

  it('uses dots for simple keys and brackets for indices', () => {
    assert.equal(formatPath(['users', 0, 'name']), '$.users[0].name');
  });

  it('bracket-quotes odd keys and escapes quotes', () => {
    assert.equal(formatPath(['odd key']), "$['odd key']");
    assert.equal(formatPath(["a'b"]), "$['a\\'b']");
  });
});

describe('summarize', () => {
  it('pluralizes items vs keys', () => {
    assert.equal(summarize([1], 1), '1 item');
    assert.equal(summarize([1, 2], 2), '2 items');
    assert.equal(summarize({ a: 1 }, 1), '1 key');
    assert.equal(summarize({ a: 1, b: 2 }, 2), '2 keys');
  });
});

describe('toPretty / toMinified', () => {
  it('round-trips through pretty and minified forms', () => {
    const value = { a: [1, 2], b: 'x' };
    assert.equal(toMinified(value), '{"a":[1,2],"b":"x"}');
    assert.equal(toPretty(value), '{\n  "a": [\n    1,\n    2\n  ],\n  "b": "x"\n}');
  });
});
