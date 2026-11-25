import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * The version lives in two manifests: the repository's and the packaged
 * application's (`release/app/package.json`, the one electron-builder and the
 * running app read). Bumping only one ships an installer whose in-app "about"
 * box and update feed disagree with the release it came from.
 */
const ROOT = path.resolve(__dirname, '..');

function readManifest(relativePath: string): { name: string; version: string; productName?: string } {
  return JSON.parse(readFileSync(path.join(ROOT, relativePath), 'utf8')) as {
    name: string;
    version: string;
    productName?: string;
  };
}

describe('version sync between package.json and release/app/package.json', () => {
  it('declares the same version and product name in both manifests', () => {
    const repo = readManifest('package.json');
    const app = readManifest('release/app/package.json');
    assert.match(repo.version, /^\d+\.\d+\.\d+$/, 'the repository version is a plain semver triplet');
    assert.equal(app.version, repo.version, 'release/app/package.json must be bumped together with package.json');
    assert.equal(app.productName, repo.productName, 'the packaged app keeps the product name the repo declares');
  });
});
