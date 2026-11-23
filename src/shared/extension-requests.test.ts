import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPendingRequestRegistry } from './extension-requests';

/** Deterministic timer queue so expiry tests never depend on wall-clock luck. */
function manualTimers() {
  let now = 0;
  let seq = 0;
  const timers: { id: number; at: number; run: () => void }[] = [];

  return {
    schedule(callback: () => void, ms: number): unknown {
      const id = (seq += 1);
      timers.push({ id, at: now + ms, run: callback });
      return id;
    },
    cancel(handle: unknown): void {
      const index = timers.findIndex((t) => t.id === handle);
      if (index >= 0) timers.splice(index, 1);
    },
    advance(ms: number): void {
      now += ms;
      const due = timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at);
      for (const timer of due) {
        const index = timers.indexOf(timer);
        if (index < 0) continue;
        timers.splice(index, 1);
        timer.run();
      }
    },
    pending(): number {
      return timers.length;
    },
  };
}

function makeRegistry(timeoutMs = 30_000) {
  const timers = manualTimers();
  const expired: string[] = [];
  const registry = createPendingRequestRegistry<string>({
    timeoutMs,
    onTimeout: (id) => expired.push(id),
    schedule: timers.schedule,
    cancel: timers.cancel,
  });
  return { registry, timers, expired };
}

describe('createPendingRequestRegistry', () => {
  it('hands back the payload registered for an id, once', () => {
    const { registry } = makeRegistry();
    assert.equal(registry.begin('a', 'first'), true);
    assert.equal(registry.settle('a'), 'first');
    assert.equal(registry.settle('a'), undefined);
    assert.equal(registry.size(), 0);
  });

  it('rejects a duplicate id so the caller keeps the original payload', () => {
    const { registry } = makeRegistry();
    assert.equal(registry.begin('dup', 'first'), true);
    assert.equal(registry.begin('dup', 'second'), false);
    assert.equal(registry.settle('dup'), 'first');
  });

  it('expires an unanswered request and reports it once', () => {
    const { registry, timers, expired } = makeRegistry(1000);
    assert.equal(registry.begin('slow', 'payload'), true);

    timers.advance(999);
    assert.equal(registry.has('slow'), true);
    assert.deepEqual(expired, []);

    timers.advance(1);
    assert.deepEqual(expired, ['slow']);
    assert.equal(registry.has('slow'), false);
    // A late reply for the expired id must be ignored, not replayed.
    assert.equal(registry.settle('slow'), undefined);
  });

  it('cancels the expiry timer when the reply arrives in time', () => {
    const { registry, timers, expired } = makeRegistry(1000);
    registry.begin('fast', 'payload');
    assert.equal(registry.settle('fast'), 'payload');
    assert.equal(timers.pending(), 0);

    timers.advance(5000);
    assert.deepEqual(expired, []);
  });

  it('tracks several in-flight requests independently', () => {
    const { registry } = makeRegistry();
    registry.begin('a', 'alpha');
    registry.begin('b', 'beta');
    assert.equal(registry.size(), 2);

    // Replies may arrive out of order — that is the whole point.
    assert.equal(registry.settle('b'), 'beta');
    assert.equal(registry.settle('a'), 'alpha');
    assert.equal(registry.size(), 0);
  });

  it('clear() drops everything without firing onTimeout', () => {
    const { registry, timers, expired } = makeRegistry();
    registry.begin('a', 'alpha');
    registry.begin('b', 'beta');

    registry.clear();
    assert.equal(registry.size(), 0);
    assert.equal(timers.pending(), 0);

    timers.advance(60_000);
    assert.deepEqual(expired, []);
    assert.equal(registry.settle('a'), undefined);
  });
});
