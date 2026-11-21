const assert = require('node:assert/strict');

function median(values) {
  assert.ok(Array.isArray(values) && values.length > 0, 'median needs values');
  assert.ok(values.every((value) => Number.isFinite(value)), 'median needs finite values');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarizeTimings(rounds, keys) {
  return Object.fromEntries(
    keys.map((key) => {
      try {
        return [key, median(rounds.map((round) => round[key]))];
      } catch (error) {
        throw new Error(`${key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    })
  );
}

module.exports = { median, summarizeTimings };
