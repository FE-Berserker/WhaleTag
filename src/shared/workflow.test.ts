import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import reducer, {
  addStage,
  removeStage,
  renameStage,
  setStageColor,
  moveStage,
  toStageToken,
  type WorkflowState,
} from '../renderer/reducers/workflow';
import { withSingleFromValues } from './smart-tags';
import { DEFAULT_WORKFLOW_STAGES } from './workflow';

/** Fresh default state (clone so tests don't share the module-level array). */
function initial(): WorkflowState {
  return { stages: DEFAULT_WORKFLOW_STAGES.map((s) => ({ ...s })) };
}
const values = (s: WorkflowState) => s.stages.map((x) => x.value);

describe('workflow reducer', () => {
  it('seeds the 5 default stages', () => {
    const s = reducer(undefined, { type: '@@INIT' });
    assert.deepEqual(values(s), [
      'not-started',
      'in-progress',
      'completed',
      'abandoned',
      'planned',
    ]);
  });

  it('adds a stage (tokenizing whitespace) and skips duplicates', () => {
    let s = reducer(initial(), addStage('On Hold', '#123456'));
    assert.ok(values(s).includes('On-Hold'));
    const n = s.stages.length;
    s = reducer(s, addStage('On Hold', '#000')); // duplicate token → no-op
    assert.equal(s.stages.length, n);
  });

  it('removes a stage by id', () => {
    const start = initial();
    const id = start.stages[1].id;
    const s = reducer(start, removeStage(id));
    assert.ok(!s.stages.some((x) => x.id === id));
    assert.equal(s.stages.length, start.stages.length - 1);
  });

  it('renames a stage; rejects collisions', () => {
    const start = initial();
    const id = start.stages[0].id;
    let s = reducer(start, renameStage(id, 'todo'));
    assert.equal(s.stages.find((x) => x.id === id)!.value, 'todo');
    // Collide with an existing value → rejected (unchanged).
    s = reducer(s, renameStage(id, 'in-progress'));
    assert.equal(s.stages.find((x) => x.id === id)!.value, 'todo');
  });

  it('sets a stage color', () => {
    const start = initial();
    const id = start.stages[0].id;
    const s = reducer(start, setStageColor(id, '#abcdef'));
    assert.equal(s.stages.find((x) => x.id === id)!.color, '#abcdef');
  });

  it('reorders stages (clamped at the ends)', () => {
    const start = initial();
    const firstId = start.stages[0].id;
    let s = reducer(start, moveStage(firstId, 1));
    assert.equal(values(s)[1], 'not-started'); // moved down one
    // Moving the now-first item up past the top is a clamped no-op.
    s = reducer(start, moveStage(firstId, -1));
    assert.deepEqual(values(s), values(start));
  });
});

describe('toStageToken', () => {
  it('collapses whitespace into a single hyphenated token', () => {
    assert.equal(toStageToken('  In   Review  '), 'In-Review');
    assert.equal(toStageToken('done'), 'done');
  });
});

describe('withSingleFromValues (dynamic workflow exclusivity)', () => {
  const vals = ['not-started', 'in-progress', 'done'];

  it('keeps only the last member of the value set', () => {
    assert.deepEqual(
      withSingleFromValues(['not-started', 'work', 'in-progress'], vals),
      ['work', 'in-progress']
    );
  });

  it('preserves tags outside the value set', () => {
    assert.deepEqual(withSingleFromValues(['work', '2026'], vals), [
      'work',
      '2026',
    ]);
  });

  it('is a no-op for an empty value set', () => {
    assert.deepEqual(withSingleFromValues(['a', 'b'], []), ['a', 'b']);
  });
});
