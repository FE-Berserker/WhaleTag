import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isGeoTag,
  parseGeoTag,
  formatGeoTag,
  geoPointFromTags,
  isValidLatLng,
  withoutGeoTags,
} from './geo-tag';

describe('geo-tag isGeoTag', () => {
  it('accepts decimal geo tags', () => {
    assert.ok(isGeoTag('geo:31.2304,121.4737'));
    assert.ok(isGeoTag('geo:-33.8688,151.2093'));
    assert.ok(isGeoTag('geo:0,0'));
  });

  it('rejects malformed geo tags', () => {
    assert.ok(!isGeoTag('geo:31.2304'));
    assert.ok(!isGeoTag('geo:31.2304,121.4737,extra'));
    assert.ok(!isGeoTag('31.2304,121.4737'));
    assert.ok(!isGeoTag('location'));
  });
});

describe('geo-tag parseGeoTag', () => {
  it('parses valid tags', () => {
    assert.deepEqual(parseGeoTag('geo:31.2304,121.4737'), {
      lat: 31.2304,
      lng: 121.4737,
    });
  });

  it('tolerates whitespace', () => {
    const point = parseGeoTag('geo: 31.2304 , 121.4737 ');
    assert.equal(point?.lat, 31.2304);
    assert.equal(point?.lng, 121.4737);
  });

  it('rejects out-of-range coordinates', () => {
    assert.equal(parseGeoTag('geo:91,0'), null);
    assert.equal(parseGeoTag('geo:0,181'), null);
  });
});

describe('geo-tag formatGeoTag', () => {
  it('formats to 6 decimal places', () => {
    assert.equal(formatGeoTag(31.2304, 121.4737), 'geo:31.230400,121.473700');
  });
});

describe('geo-tag geoPointFromTags', () => {
  it('returns the first geo point', () => {
    const tags = ['work', 'geo:31.2304,121.4737', '2026'];
    assert.deepEqual(geoPointFromTags(tags), { lat: 31.2304, lng: 121.4737 });
  });

  it('returns null when no geo tags exist', () => {
    assert.equal(geoPointFromTags(['work', '2026']), null);
  });
});

describe('geo-tag isValidLatLng', () => {
  it('accepts valid ranges', () => {
    assert.ok(isValidLatLng(0, 0));
    assert.ok(isValidLatLng(90, 180));
    assert.ok(isValidLatLng(-90, -180));
  });

  it('rejects invalid ranges', () => {
    assert.ok(!isValidLatLng(91, 0));
    assert.ok(!isValidLatLng(0, 181));
    assert.ok(!isValidLatLng(NaN, 0));
  });
});

describe('geo-tag withoutGeoTags', () => {
  it('removes only geo tags', () => {
    assert.deepEqual(withoutGeoTags(['work', 'geo:31,121', '2026']), [
      'work',
      '2026',
    ]);
  });
});
