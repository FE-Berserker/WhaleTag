import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
type TestingLibrary = typeof import('@testing-library/react');
let cleanup: TestingLibrary['cleanup'];
let fireEvent: TestingLibrary['fireEvent'];
let render: TestingLibrary['render'];

let InlineRenameInput: typeof import('./Row').InlineRenameInput;
let cleanupDom: (() => void) | undefined;
before(async () => {
  cleanupDom = globalJsdom();
  ({ cleanup, fireEvent, render } = await import('@testing-library/react'));
  InlineRenameInput = (await import('./Row')).InlineRenameInput;
});
afterEach(() => cleanup());
after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  cleanupDom?.();
});

describe('InlineRenameInput IME commit', () => {
  it('does not commit Enter from an active composition', () => {
    const commits: string[] = [];
    const view = render(
      <InlineRenameInput
        initial="before.txt"
        onCommit={(value) => commits.push(value)}
        onCancel={() => undefined}
      />
    );
    const input = view.getByDisplayValue('before.txt') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'after.txt' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    assert.deepEqual(commits, []);

    fireEvent.keyDown(input, { key: 'Enter' });
    assert.deepEqual(commits, ['after.txt']);
  });
});
