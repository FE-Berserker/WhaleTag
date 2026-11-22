import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseExcalidrawScene } from './scene-content';

describe('Excalidraw scene content validation', () => {
  it('accepts a blank new document and valid scene shapes', () => {
    assert.deepEqual(parseExcalidrawScene('  \n'), {});
    assert.deepEqual(parseExcalidrawScene('{"type":"excalidraw"}'), {
      type: 'excalidraw',
    });
    const valid = parseExcalidrawScene(
      '{"type":"excalidraw","version":2,"elements":[],"appState":{}}'
    );
    assert.deepEqual(valid.elements, []);
  });

  it('rejects malformed JSON before restore can fail open', () => {
    assert.throws(() => parseExcalidrawScene('{broken'), /JSON|Unexpected|property|position/i);
  });

  it('rejects valid JSON that is not an Excalidraw scene', () => {
    const invalid = [
      '{}',
      '[]',
      'null',
      '"scene"',
      '{"type":"excalidrawlib","libraryItems":[]}',
      '{"nodes":[]}',
      '{"type":"other","elements":[]}',
      '{"type":"excalidraw","elements":{}}',
      '{"type":"excalidraw","elements":null}',
    ];
    for (const content of invalid) {
      assert.throws(
        () => parseExcalidrawScene(content),
        /not an Excalidraw scene/,
        content
      );
    }
  });
});
