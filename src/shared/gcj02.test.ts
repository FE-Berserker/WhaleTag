import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { wgs84ToGcj02, gcj02ToWgs84, outOfChina } from './gcj02';

describe('gcj02 outOfChina', () => {
  it('treats China coordinates as in-China', () => {
    assert.equal(outOfChina(39.9087, 116.3975), false); // Beijing
    assert.equal(outOfChina(31.2304, 121.4737), false); // Shanghai
  });
  it('treats foreign coordinates as out-of-China', () => {
    assert.equal(outOfChina(40.7128, -74.006), true); // New York
    assert.equal(outOfChina(51.5074, -0.1278), true); // London
  });
});

describe('gcj02 wgs84ToGcj02', () => {
  it('offsets a Beijing WGS-84 point into GCJ-02 (~hundreds of metres)', () => {
    const g = wgs84ToGcj02(39.90847, 116.39124);
    // Known approximate GCJ-02 for Tiananmen.
    assert.ok(Math.abs(g.lat - 39.90972) < 0.0005, `lat was ${g.lat}`);
    assert.ok(Math.abs(g.lng - 116.39751) < 0.0005, `lng was ${g.lng}`);
    // The offset is non-trivial (not an identity transform inside China).
    assert.ok(Math.abs(g.lat - 39.90847) > 0.0005);
    assert.ok(Math.abs(g.lng - 116.39124) > 0.0005);
  });

  it('is an identity transform outside China', () => {
    const g = wgs84ToGcj02(40.7128, -74.006);
    assert.deepEqual(g, { lat: 40.7128, lng: -74.006 });
  });
});

describe('gcj02 gcj02ToWgs84', () => {
  it('round-trips within a metre (sub-0.00001°)', () => {
    const orig = { lat: 35.959605, lng: 117.839355 };
    const g = wgs84ToGcj02(orig.lat, orig.lng);
    const back = gcj02ToWgs84(g.lat, g.lng);
    assert.ok(Math.abs(back.lat - orig.lat) < 1e-5, `lat drift ${back.lat - orig.lat}`);
    assert.ok(Math.abs(back.lng - orig.lng) < 1e-5, `lng drift ${back.lng - orig.lng}`);
  });

  it('is an identity transform outside China', () => {
    const w = gcj02ToWgs84(51.5074, -0.1278);
    assert.deepEqual(w, { lat: 51.5074, lng: -0.1278 });
  });
});
