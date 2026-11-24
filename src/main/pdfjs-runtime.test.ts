import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { withPdfjsNodeRuntime } from './pdfjs-runtime';

function restoreDescriptor(descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(process, 'type', descriptor);
}

describe('withPdfjsNodeRuntime', () => {
  it('normalizes a utility process only during the load and preserves its descriptor', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'type');
    const utility: PropertyDescriptor = {
      value: 'utility',
      configurable: true,
      writable: false,
      enumerable: true,
    };
    try {
      Object.defineProperty(process, 'type', utility);
      const result = withPdfjsNodeRuntime(() => {
        assert.equal(process.type, 'browser');
        assert.equal(Object.getOwnPropertyDescriptor(process, 'type')?.enumerable, true);
        return 42;
      });
      assert.equal(result, 42);
      assert.deepEqual(Object.getOwnPropertyDescriptor(process, 'type'), utility);
    } finally {
      restoreDescriptor(original);
    }
  });

  it('restores the utility descriptor when loading throws', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'type');
    const utility: PropertyDescriptor = {
      value: 'utility',
      configurable: true,
      writable: false,
      enumerable: true,
    };
    try {
      Object.defineProperty(process, 'type', utility);
      assert.throws(
        () =>
          withPdfjsNodeRuntime(() => {
            throw new Error('load failed');
          }),
        /load failed/
      );
      assert.deepEqual(Object.getOwnPropertyDescriptor(process, 'type'), utility);
    } finally {
      restoreDescriptor(original);
    }
  });
});
