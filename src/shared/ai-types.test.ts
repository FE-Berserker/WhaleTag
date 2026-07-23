import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseAskUserQuestions } from './ai-types';

const VALID = {
  questions: [
    {
      question: 'Which library should we use?',
      header: 'Library',
      options: [
        { label: 'date-fns', description: 'Lightweight' },
        { label: 'dayjs', description: 'Moment-like API', preview: 'dayjs()' },
      ],
      multiSelect: false,
    },
    {
      question: 'Which features do you want?',
      header: 'Features',
      options: [
        { label: 'Search' },
        { label: 'Tags' },
        { label: 'Sync' },
      ],
      multiSelect: true,
    },
  ],
};

describe('parseAskUserQuestions', () => {
  it('parses a full valid payload, keeping optional fields', () => {
    const parsed = parseAskUserQuestions(VALID);
    assert.ok(parsed);
    assert.equal(parsed.length, 2);
    assert.deepEqual(parsed[0], {
      question: 'Which library should we use?',
      header: 'Library',
      options: [
        { label: 'date-fns', description: 'Lightweight' },
        { label: 'dayjs', description: 'Moment-like API', preview: 'dayjs()' },
      ],
      multiSelect: false,
    });
    // Missing description/preview are omitted; header/multiSelect normalized.
    assert.deepEqual(parsed[1].options[0], { label: 'Search' });
    assert.equal(parsed[1].multiSelect, true);
  });

  it('coerces a missing multiSelect to false', () => {
    const parsed = parseAskUserQuestions({
      questions: [
        {
          question: 'Pick one?',
          header: 'X',
          options: [{ label: 'a' }, { label: 'b' }],
        },
      ],
    });
    assert.ok(parsed);
    assert.equal(parsed[0].multiSelect, false);
    assert.equal(parsed[0].header, 'X');
  });

  it('returns null when questions is missing / empty / not an array', () => {
    assert.equal(parseAskUserQuestions({}), null);
    assert.equal(parseAskUserQuestions({ questions: [] }), null);
    assert.equal(parseAskUserQuestions({ questions: 'nope' }), null);
  });

  it('returns null on malformed entries (bad question or option label)', () => {
    assert.equal(
      parseAskUserQuestions({
        questions: [{ question: '', header: 'x', options: [{ label: 'a' }] }],
      }),
      null
    );
    assert.equal(
      parseAskUserQuestions({
        questions: [
          { question: 'ok?', header: 'x', options: [{ label: 42 }] },
        ],
      }),
      null
    );
    assert.equal(
      parseAskUserQuestions({
        questions: [{ question: 'ok?', header: 'x', options: [] }],
      }),
      null
    );
  });
});
