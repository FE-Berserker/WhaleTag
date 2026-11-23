import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createPersistFailureReporter } from './persist-failure';

function setup() {
  const notices: { message: string; severity?: string }[] = [];
  let pauses = 0;
  let now = 0;
  const reporter = createPersistFailureReporter({
    pause: () => {
      pauses += 1;
    },
    notify: (message, severity) => {
      notices.push({ message, severity });
    },
    translate: (key) => `t:${key}`,
    log: () => {},
    now: () => now,
  });
  return {
    reporter,
    notices,
    pauses: () => pauses,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('persist failure reporter', () => {
  it('pauses once and shows a single read notice for repeated read failures', () => {
    const helper = setup();

    helper.reporter('read', new Error('first'));
    helper.reporter('read', new Error('second'));

    assert.equal(helper.pauses(), 1);
    assert.deepEqual(helper.notices, [
      { message: 't:persistReadFailed', severity: 'error' },
    ]);
  });

  it('shows write notices at most once per 30 seconds', () => {
    const helper = setup();

    helper.reporter('write', new Error('a'));
    helper.advance(29_999);
    helper.reporter('write', new Error('b'));
    assert.equal(helper.notices.length, 1);

    helper.advance(1);
    helper.reporter('write', new Error('c'));
    assert.equal(helper.notices.length, 2);
    assert.equal(helper.notices[1].message, 't:persistWriteFailed');
  });

  it('does not pause on write or delete failures', () => {
    const helper = setup();

    helper.reporter('write', new Error('a'));
    helper.reporter('delete', new Error('b'));

    assert.equal(helper.pauses(), 0);
  });
});
