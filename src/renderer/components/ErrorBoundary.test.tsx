import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import ErrorBoundary from './ErrorBoundary';

type TestingLibrary = typeof import('@testing-library/react');
let cleanup: TestingLibrary['cleanup'];
let render: TestingLibrary['render'];
let cleanupDom: (() => void) | undefined;

function Bomb({ error }: { error: Error | null }) {
  if (error) throw error;
  return <div>Recovered children</div>;
}

before(async () => {
  cleanupDom = globalJsdom();
  ({ cleanup, render } = await import('@testing-library/react'));
});

afterEach(() => cleanup());
after(() => cleanupDom?.());

describe('ErrorBoundary recovery', () => {
  it('keeps the default root recovery UI when no local fallback is supplied', (t) => {
    t.mock.method(console, 'error', () => undefined);
    const view = render(
      <ErrorBoundary>
        <Bomb error={new Error('root failure')} />
      </ErrorBoundary>
    );

    assert.ok(view.getByText('Something went wrong'));
    assert.ok(view.getByRole('button', { name: 'Reload / 重载' }));
    assert.ok(view.getByText(/root failure/));
  });

  it('renders children again when resetKey changes after a local failure', (t) => {
    t.mock.method(console, 'error', () => undefined);
    const view = render(
      <ErrorBoundary resetKey={0} fallback={<div>Local failure</div>}>
        <Bomb error={new Error('local failure')} />
      </ErrorBoundary>
    );
    assert.ok(view.getByText('Local failure'));

    view.rerender(
      <ErrorBoundary resetKey={1} fallback={<div>Local failure</div>}>
        <Bomb error={null} />
      </ErrorBoundary>
    );

    assert.ok(view.getByText('Recovered children'));
    assert.equal(view.queryByText('Local failure'), null);
  });

  it('keeps a failure for an unchanged resetKey and reports onError once', (t) => {
    t.mock.method(console, 'error', () => undefined);
    let errors = 0;
    const failure = new Error('persistent failure');
    const view = render(
      <ErrorBoundary
        resetKey={0}
        fallback={<div>Persistent local failure</div>}
        onError={() => {
          errors += 1;
        }}
      >
        <Bomb error={failure} />
      </ErrorBoundary>
    );
    assert.ok(view.getByText('Persistent local failure'));

    view.rerender(
      <ErrorBoundary
        resetKey={0}
        fallback={<div>Persistent local failure</div>}
        onError={() => {
          errors += 1;
        }}
      >
        <Bomb error={failure} />
      </ErrorBoundary>
    );

    assert.ok(view.getByText('Persistent local failure'));
    assert.equal(view.queryByText('Recovered children'), null);
    assert.equal(errors, 1);
  });
});
