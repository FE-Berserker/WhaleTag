import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAskUserAnswers,
  emptyAskUserSelections,
} from './askUserAnswers';
import type { AskUserQuestionItem } from '../../../shared/ai-types';

const QUESTIONS: AskUserQuestionItem[] = [
  {
    question: 'Which library?',
    header: 'Library',
    options: [
      { label: 'date-fns', description: 'Lightweight' },
      { label: 'dayjs', description: 'Moment-like API' },
    ],
    multiSelect: false,
  },
  {
    question: 'Which features?',
    header: 'Features',
    options: [{ label: 'Search' }, { label: 'Tags' }],
    multiSelect: true,
  },
];

describe('emptyAskUserSelections', () => {
  it('initializes one empty entry per question, keyed by question text', () => {
    const sels = emptyAskUserSelections(QUESTIONS);
    assert.deepEqual(sels, {
      'Which library?': { selected: [], otherChecked: false, other: '' },
      'Which features?': { selected: [], otherChecked: false, other: '' },
    });
  });
});

describe('buildAskUserAnswers', () => {
  it('maps question text to the selected option label', () => {
    const answers = buildAskUserAnswers(QUESTIONS, {
      'Which library?': {
        selected: ['dayjs'],
        otherChecked: false,
        other: '',
      },
      'Which features?': {
        selected: ['Search', 'Tags'],
        otherChecked: false,
        other: '',
      },
    });
    assert.deepEqual(answers, {
      'Which library?': 'dayjs',
      'Which features?': 'Search, Tags',
    });
  });

  it('uses the free text itself for an "Other" answer, never the word Other', () => {
    const answers = buildAskUserAnswers(QUESTIONS, {
      'Which library?': {
        selected: [],
        otherChecked: true,
        other: '  Temporal  ',
      },
      'Which features?': { selected: ['Tags'], otherChecked: false, other: '' },
    });
    assert.deepEqual(answers, {
      'Which library?': 'Temporal',
      'Which features?': 'Tags',
    });
  });

  it('appends Other text after checked options for multi-select', () => {
    const answers = buildAskUserAnswers(QUESTIONS, {
      'Which library?': { selected: ['date-fns'], otherChecked: false, other: '' },
      'Which features?': {
        selected: ['Search'],
        otherChecked: true,
        other: 'AI chat',
      },
    });
    assert.deepEqual(answers, {
      'Which library?': 'date-fns',
      'Which features?': 'Search, AI chat',
    });
  });

  it('returns null while any question is unanswered (submit stays disabled)', () => {
    // Second question untouched.
    assert.equal(
      buildAskUserAnswers(QUESTIONS, {
        'Which library?': { selected: ['dayjs'], otherChecked: false, other: '' },
        'Which features?': { selected: [], otherChecked: false, other: '' },
      }),
      null
    );
    // Other checked but no text typed counts as unanswered.
    assert.equal(
      buildAskUserAnswers(QUESTIONS, {
        'Which library?': { selected: [], otherChecked: true, other: '   ' },
        'Which features?': { selected: ['Tags'], otherChecked: false, other: '' },
      }),
      null
    );
  });
});
