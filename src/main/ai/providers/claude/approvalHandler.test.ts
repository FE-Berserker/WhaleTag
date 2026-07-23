import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createCanUseTool,
  decideToolCall,
  type ApprovalCallback,
} from './approvalHandler';
import type { AskUserQuestionItem } from '../../../../shared/ai-types';

const GUARD_CTX = { readOnlyRoots: [], cwd: '/tmp' };

/** CanUseTool's third argument (`toolUseID` is required by the SDK type). */
const OPTS = { signal: new AbortController().signal, toolUseID: 'tu_test' };

const QUESTIONS: AskUserQuestionItem[] = [
  {
    question: 'Which library should we use?',
    header: 'Library',
    options: [
      { label: 'date-fns', description: 'Lightweight' },
      { label: 'dayjs', description: 'Moment-like API' },
    ],
    multiSelect: false,
  },
];
const QUESTION_INPUT = { questions: QUESTIONS };

/** An approval callback that fails the test if it is ever invoked. */
const noApprovalExpected: ApprovalCallback = () => {
  throw new Error('approvalCallback must not be called for AskUserQuestion');
};

describe('createCanUseTool — AskUserQuestion', () => {
  it('returns allow with updatedInput carrying the user answers', async () => {
    const canUseTool = createCanUseTool(
      noApprovalExpected,
      GUARD_CTX,
      'normal',
      async (input) => {
        assert.deepEqual(input, QUESTION_INPUT);
        return { 'Which library should we use?': 'dayjs' };
      }
    );
    const result = await canUseTool('AskUserQuestion', QUESTION_INPUT, OPTS);
    assert.deepEqual(result, {
      behavior: 'allow',
      updatedInput: {
        ...QUESTION_INPUT,
        answers: { 'Which library should we use?': 'dayjs' },
      },
    });
  });

  it('denies with a guidance message when the user declines (null answers)', async () => {
    const canUseTool = createCanUseTool(
      noApprovalExpected,
      GUARD_CTX,
      'normal',
      async () => null
    );
    const result = await canUseTool('AskUserQuestion', QUESTION_INPUT, OPTS);
    assert.equal(result.behavior, 'deny');
    assert.match(
      (result as { message: string }).message,
      /declined to answer/
    );
  });

  it('denies cleanly when no askUserCallback is wired', async () => {
    const canUseTool = createCanUseTool(
      noApprovalExpected,
      GUARD_CTX,
      'normal'
    );
    const result = await canUseTool('AskUserQuestion', QUESTION_INPUT, OPTS);
    assert.equal(result.behavior, 'deny');
    assert.match(
      (result as { message: string }).message,
      /not available in this context/
    );
  });

  it('intercepts even in yolo mode (the gate never sees it when the SDK shadows canUseTool, but the interceptor itself is unconditional)', async () => {
    const canUseTool = createCanUseTool(
      noApprovalExpected,
      GUARD_CTX,
      'yolo',
      async () => ({ 'Which library should we use?': 'date-fns' })
    );
    const result = await canUseTool('AskUserQuestion', QUESTION_INPUT, OPTS);
    assert.equal(result.behavior, 'allow');
  });
});

describe('createCanUseTool — non-question tools unchanged', () => {
  it('auto-allows read tools without the approval callback', async () => {
    const canUseTool = createCanUseTool(
      noApprovalExpected,
      GUARD_CTX,
      'normal',
      async () => null
    );
    const result = await canUseTool('Read', { file_path: '/tmp/x' }, OPTS);
    assert.deepEqual(result, { behavior: 'allow' });
  });

  it('routes write tools to the approval callback in normal mode', async () => {
    const canUseTool = createCanUseTool(
      async () => ({ decision: 'allow' }),
      GUARD_CTX,
      'normal',
      async () => null
    );
    const result = await canUseTool(
      'Write',
      { file_path: '/tmp/x', content: 'y' },
      OPTS
    );
    assert.deepEqual(result, { behavior: 'allow' });
  });
});

describe('decideToolCall — unchanged semantics', () => {
  it('yolo auto-allows write tools past the guard', async () => {
    const decision = await decideToolCall(
      'Write',
      { file_path: '/tmp/x' },
      GUARD_CTX,
      noApprovalExpected,
      'yolo'
    );
    assert.deepEqual(decision, { behavior: 'allow' });
  });

  it('forwards the plan-mode feedback note as the deny message', async () => {
    const decision = await decideToolCall(
      'ExitPlanMode',
      { plan: 'do X' },
      GUARD_CTX,
      async () => ({ decision: 'deny', note: 'use dayjs instead' })
    );
    assert.equal(decision.behavior, 'deny');
    assert.equal(
      (decision as { message: string }).message,
      'User requested changes: use dayjs instead'
    );
  });

  it('falls back to the generic deny message without a note', async () => {
    const decision = await decideToolCall(
      'Write',
      { file_path: '/tmp/x' },
      GUARD_CTX,
      async () => ({ decision: 'deny', note: '   ' })
    );
    assert.equal(decision.behavior, 'deny');
    assert.equal(
      (decision as { message: string }).message,
      'User denied this action.'
    );
  });
});
