import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_WORKFLOW_DEFS,
  QUADRANT_DEFS,
} from '../../shared/smart-tags';
import { createSmartTagCatalog } from './mcp-smart-tag-catalog';

describe('mcp smart-tag catalog', () => {
  it('derives canonical workflow, quadrant and rating values from shared definitions', () => {
    const catalog = createSmartTagCatalog();
    assert.deepEqual(
      catalog.families.workflow.values.map(({ value }) => value),
      DEFAULT_WORKFLOW_DEFS.map(({ value }) => value)
    );
    assert.deepEqual(
      catalog.families.quadrant.values.map(({ value }) => value),
      QUADRANT_DEFS.map(({ value }) => value)
    );
    assert.deepEqual(
      catalog.families.rating.values.map(({ value }) => value),
      ['1star', '2star', '3star', '4star', '5star']
    );
    assert.deepEqual(
      catalog.families.rating.values.map(({ uiAlias }) => uiAlias),
      ['star1', 'star2', 'star3', 'star4', 'star5']
    );
    assert.equal(catalog.families.workflow.exclusive, true);
    assert.equal(catalog.families.workflow.customizable, true);
    assert.equal(
      catalog.families.workflow.mcpExclusivity,
      'built-in-defaults-only'
    );
    assert.match(
      catalog.families.workflow.note,
      /explicitly remove every previous workflow stage/
    );
    assert.deepEqual(catalog.families.workflow.views, ['task']);
    assert.equal(catalog.families.workflow.taskMode, 'kanban');
    assert.equal(catalog.families.quadrant.exclusive, true);
    assert.deepEqual(catalog.families.quadrant.views, ['task']);
    assert.equal(catalog.families.quadrant.taskMode, 'matrix');
    assert.equal(catalog.families.rating.exclusive, true);
  });

  it('explains dynamic date forms and the WGS-84 map coordinate contract', () => {
    const catalog = createSmartTagCatalog();
    const today = catalog.families.smartDate.values.find(
      ({ uiAlias }) => uiAlias === 'today'
    );
    const now = catalog.families.smartDate.values.find(
      ({ uiAlias }) => uiAlias === 'now'
    );
    assert.match(today?.storedForm ?? '', /^YYYYMMDD/);
    assert.match(now?.storedForm ?? '', /^YYYYMMDDTHHMM/);
    assert.equal(catalog.families.period.valuePattern, 'YYYYMMDD-YYYYMMDD');
    assert.equal(catalog.families.geo.coordinateSystem, 'WGS-84');
    assert.equal(catalog.families.geo.valuePattern, 'geo:<latitude>,<longitude>');
    assert.equal(catalog.families.geo.exclusive, false);
    assert.equal(catalog.families.geo.multiple, true);
    assert.match(catalog.families.geo.note, /first valid coordinate/);
    assert.match(catalog.families.geo.note, /UI edits replace existing geo tags/);
    assert.deepEqual(catalog.families.geo.latitudeRange, [-90, 90]);
    assert.deepEqual(catalog.families.geo.longitudeRange, [-180, 180]);
  });

  it('warns that MCP requires stored values rather than resolving UI aliases', () => {
    const catalog = createSmartTagCatalog();
    assert.equal(catalog.applyTool, 'whale_apply_tags');
    assert.match(catalog.usage.canonicalValues, /exact canonical values/);
    assert.match(catalog.usage.canonicalValues, /does not resolve/);
    assert.match(catalog.usage.discovery, /whale_list_tags/);
  });
});
