import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  beginExcalidrawSave,
  createExcalidrawSaveState,
  observeExcalidrawJson,
  resetObservedJson,
  resolveExcalidrawSaveAck,
} from './save-state';

describe('Excalidraw revision-aware save state', () => {
  it('keeps a stale-ack baseline at the written snapshot and newer edits dirty', () => {
    let state = resetObservedJson(createExcalidrawSaveState(), 'disk zero');
    state = observeExcalidrawJson(state, 'edit one');
    assert.equal(state.revision, 1);

    const save = beginExcalidrawSave(state, 'edit one');
    state = save.state;
    assert.equal(save.snapshot.revision, 1);

    state = observeExcalidrawJson(state, 'edit two while write is pending');
    assert.equal(state.revision, 2);
    const ack = resolveExcalidrawSaveAck(save.snapshot, state.observedJson);
    state = { ...state, pendingSave: null };

    assert.equal(ack.baselineJson, 'edit one');
    assert.equal(ack.dirty, true);
    assert.equal(state.observedJson, 'edit two while write is pending');
    assert.equal(state.revision, 2);

    const secondSave = beginExcalidrawSave(state, state.observedJson);
    assert.equal(secondSave.snapshot.revision, 2);
    assert.deepEqual(
      resolveExcalidrawSaveAck(secondSave.snapshot, state.observedJson),
      { baselineJson: 'edit two while write is pending', dirty: false }
    );
  });

  it('becomes clean when edits return to the snapshot covered by a stale ack', () => {
    let state = resetObservedJson(createExcalidrawSaveState(), 'disk zero');
    state = observeExcalidrawJson(state, 'edit one');
    const save = beginExcalidrawSave(state, 'edit one');
    state = save.state;
    state = observeExcalidrawJson(state, 'temporary edit');
    state = observeExcalidrawJson(state, 'edit one');

    assert.ok(state.revision > save.snapshot.revision);
    assert.deepEqual(resolveExcalidrawSaveAck(save.snapshot, state.observedJson), {
      baselineJson: 'edit one',
      dirty: false,
    });
  });

  it('increments revision only when serialized JSON changes', () => {
    let state = resetObservedJson(createExcalidrawSaveState(), 'loaded');
    assert.equal(state.revision, 0);
    state = observeExcalidrawJson(state, 'loaded');
    state = observeExcalidrawJson(state, 'loaded');
    assert.equal(state.revision, 0, 'selection-only callbacks are not revisions');

    const save = beginExcalidrawSave(state, 'loaded');
    assert.equal(save.snapshot.revision, 0);
    state = observeExcalidrawJson(save.state, 'real edit');
    assert.equal(state.revision, 1);
  });
});
