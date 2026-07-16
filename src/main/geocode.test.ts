import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { geocodeNominatim } from './geocode';

/** Minimal fetch mock that records calls and returns canned Nominatim JSON. */
function mockFetch(items: unknown[], status = 200) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = async (
    url: string,
    init?: { headers?: Record<string, string> }
  ) => {
    calls.push({ url, headers: init?.headers ?? {} });
    return { ok: status >= 200 && status < 300, status, json: async () => items };
  };
  return { fetchImpl, calls };
}

describe('geocodeNominatim', () => {
  it('returns [] for an empty/whitespace query and makes no request', async () => {
    const { fetchImpl, calls } = mockFetch([]);
    assert.deepEqual(
      await geocodeNominatim('   ', { userAgent: 'WhaleTag/0.3.0', fetchImpl }),
      []
    );
    assert.equal(calls.length, 0);
  });

  it('parses Nominatim jsonv2 into {name,lat,lng} and sends the policy params', async () => {
    const { fetchImpl, calls } = mockFetch([
      { display_name: 'Tiananmen, Beijing', lat: '39.9055', lon: '116.3976' },
      { display_name: 'Shanghai', lat: '31.2304', lon: '121.4737' },
    ]);
    const results = await geocodeNominatim('天安门', {
      userAgent: 'WhaleTag/0.3.0',
      fetchImpl,
    });
    assert.equal(results.length, 2);
    assert.equal(results[0].name, 'Tiananmen, Beijing');
    assert.equal(results[0].lat, 39.9055);
    assert.equal(results[0].lng, 116.3976);
    // Nominatim compliance: countrycodes + limit + accept-language + encoded q.
    assert.ok(calls[0].url.includes('q='));
    assert.ok(calls[0].url.includes('countrycodes=cn'));
    assert.ok(calls[0].url.includes('limit=5'));
    assert.ok(calls[0].url.includes('accept-language=zh'));
    // Required identifying User-Agent.
    assert.equal(calls[0].headers['User-Agent'], 'WhaleTag/0.3.0');
  });

  it('skips items with missing/invalid coordinates or name', async () => {
    const { fetchImpl } = mockFetch([
      { display_name: 'OK', lat: '1', lon: '2' },
      { display_name: 'no coords' }, // missing lat/lon
      { display_name: 'bad lat', lat: 'not-a-number', lon: '2' },
      { display_name: '', lat: '3', lon: '4' }, // empty name
      { lat: '5', lon: '6' }, // missing display_name
    ]);
    const results = await geocodeNominatim('x', {
      userAgent: 'UA',
      fetchImpl,
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'OK');
  });

  it('throws on a non-ok HTTP response', async () => {
    const { fetchImpl } = mockFetch([], 503);
    await assert.rejects(
      geocodeNominatim('x', { userAgent: 'UA', fetchImpl }),
      /HTTP 503/
    );
  });
});
