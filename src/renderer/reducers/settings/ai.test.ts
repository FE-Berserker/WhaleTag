import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  aiInitial,
  migrateAi,
  reduceAi,
  setAiSettings,
} from './ai';
import type { AiFields } from './ai';

describe('ai.aiMaxTurns', () => {
  it('aiInitial.aiMaxTurns is 200 (raised from the old hardcoded 50)', () => {
    assert.equal(aiInitial.aiMaxTurns, 200);
  });

  it('migrateAi backfills aiMaxTurns=200 when absent (legacy persisted state)', () => {
    // Simulate a persisted slice from before aiMaxTurns shipped.
    const legacy = {
      ...aiInitial,
      aiMaxTurns: undefined,
    } as unknown as AiFields;
    const next = migrateAi(legacy);
    assert.equal(next.aiMaxTurns, 200);
  });

  it('migrateAi preserves an existing aiMaxTurns value', () => {
    const seeded = { ...aiInitial, aiMaxTurns: 500 };
    const next = migrateAi(seeded);
    assert.equal(next.aiMaxTurns, 500);
  });

  it('reduceAi updates aiMaxTurns via SET_AI_SETTINGS', () => {
    const next = reduceAi(aiInitial, setAiSettings({ aiMaxTurns: 100 }));
    assert.equal(next.aiMaxTurns, 100);
  });

  it('reduceAi returns a fresh object on SET_AI_SETTINGS (immutability)', () => {
    const next = reduceAi(aiInitial, setAiSettings({ aiMaxTurns: 300 }));
    assert.notEqual(next, aiInitial);
    assert.equal(aiInitial.aiMaxTurns, 200); // base untouched
  });
});
