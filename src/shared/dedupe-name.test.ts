import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nextAvailableName } from './dedupe-name';

describe('nextAvailableName', () => {
  it('returns the name unchanged when free', () => {
    assert.equal(nextAvailableName('report.pdf', new Set()), 'report.pdf');
  });

  it('inserts " (1)" before the extension on first collision', () => {
    assert.equal(
      nextAvailableName('report.pdf', new Set(['report.pdf'])),
      'report (1).pdf'
    );
  });

  it('increments until a free name is found', () => {
    const taken = new Set(['a.txt', 'a (1).txt', 'a (2).txt']);
    assert.equal(nextAvailableName('a.txt', taken), 'a (3).txt');
  });

  it('handles names with no extension', () => {
    assert.equal(
      nextAvailableName('README', new Set(['README'])),
      'README (1)'
    );
  });

  it('treats a leading-dot file as having no extension', () => {
    assert.equal(nextAvailableName('.env', new Set(['.env'])), '.env (1)');
  });

  it('keeps multi-dot extensions intact (splits on the last dot)', () => {
    assert.equal(
      nextAvailableName('archive.tar.gz', new Set(['archive.tar.gz'])),
      'archive.tar (1).gz'
    );
  });
});
