import {
  DEFAULT_WORKFLOW_DEFS,
  QUADRANT_DEFS,
  RATING_TAGS,
  SMART_TAGS,
  ratingOfFunctionality,
  type SmartFunctionality,
} from '../../shared/smart-tags';

/**
 * JSON-safe, renderer-independent vocabulary for MCP clients. Keep canonical
 * values derived from shared/smart-tags so this catalog cannot drift from the
 * normalization rules used by whale_apply_tags.
 *
 * This deliberately describes stored values, not UI-only template resolution:
 * whale_apply_tags normalizes exclusive families but does not call
 * resolveInputTag. In particular, `star5` and `5star` are not interchangeable.
 */
export function createSmartTagCatalog() {
  return {
    schemaVersion: 1,
    applyTool: 'whale_apply_tags',
    usage: {
      discovery:
        'Read this catalog before semantic tagging. whale_list_tags only reports values already present in a location index and its library descriptions.',
      canonicalValues:
        'Pass the exact canonical values below in add/remove. UI aliases are informational; whale_apply_tags does not resolve template aliases.',
      exclusivity:
        'For exclusive families, whale_apply_tags keeps the newest recognized value and removes earlier values in that family. Automatic workflow exclusivity covers only the built-in default values; see workflow.note for custom stages. Different families can coexist.',
      storage:
        'Tags are merge-safe .whale/ sidecar metadata; file names and contents are not modified.',
    },
    families: {
      workflow: {
        description: 'Task status used by the Kanban board.',
        views: ['task'],
        taskMode: 'kanban',
        exclusive: true,
        customizable: true,
        mcpExclusivity: 'built-in-defaults-only',
        note:
          'These are the built-in default stages, and only these values are automatically made exclusive by whale_apply_tags. Users can edit stages in Workflow Manager; whale_list_tags can reveal custom values already used in the location, but MCP cannot discover the live stage list. Whenever a workflow change involves a custom stage, explicitly remove every previous workflow stage tag in the same call.',
        values: DEFAULT_WORKFLOW_DEFS.map(({ functionality, value }) => ({
          value,
          uiAlias: functionality,
        })),
      },
      quadrant: {
        description: 'Eisenhower urgency/importance classification used by the task Matrix view.',
        views: ['task'],
        taskMode: 'matrix',
        exclusive: true,
        values: QUADRANT_DEFS.map(({ functionality, value }) => ({
          value,
          uiAlias: functionality,
          meaning: quadrantMeaning(value),
        })),
      },
      rating: {
        description: 'One-to-five-star file rating.',
        views: ['list', 'grid', 'gallery', 'task'],
        exclusive: true,
        values: RATING_TAGS.map(({ functionality, title }) => {
          const stars = ratingOfFunctionality(functionality);
          if (stars === null) {
            throw new Error(`Rating definition ${functionality} has no numeric value`);
          }
          return {
            value: `${stars}star`,
            stars,
            label: title,
            uiAlias: functionality,
          };
        }),
      },
      smartDate: {
        description: 'Dynamic local-date smart tags. Compute the canonical stored value before applying.',
        views: ['calendar'],
        exclusive: true,
        dynamic: true,
        values: SMART_TAGS.map(({ functionality, title }) => ({
          uiAlias: functionality,
          title,
          storedForm: smartDateStorageForm(functionality),
        })),
      },
      period: {
        description: 'An inclusive local-date range; independent from smartDate.',
        views: ['calendar'],
        exclusive: true,
        valuePattern: 'YYYYMMDD-YYYYMMDD',
        example: '20260704-20260710',
        note: 'Reversed bounds are accepted and normalized for range interpretation.',
      },
      geo: {
        description: 'WGS-84 decimal-degree coordinate shown by the Mapique map view.',
        views: ['mapique'],
        exclusive: false,
        multiple: true,
        valuePattern: 'geo:<latitude>,<longitude>',
        coordinateSystem: 'WGS-84',
        latitudeRange: [-90, 90],
        longitudeRange: [-180, 180],
        example: 'geo:31.230400,121.473700',
        note:
          'Multiple geo tags may coexist in sidecar metadata, but Mapique displays only the first valid coordinate. Map and EXIF UI edits replace existing geo tags with one value. To change the displayed point through whale_apply_tags, remove the old geo tags while adding the new one; invalid coordinates are not map points.',
      },
    },
  };
}

function quadrantMeaning(value: string): string {
  switch (value) {
    case 'urgent-important':
      return 'Urgent and important; do first.';
    case 'urgent-unimportant':
      return 'Urgent but not important; delegate.';
    case 'noturgent-important':
      return 'Important but not urgent; schedule.';
    case 'noturgent-unimportant':
      return 'Neither urgent nor important; eliminate.';
    default:
      return value;
  }
}

function smartDateStorageForm(functionality: SmartFunctionality): string {
  switch (functionality) {
    case 'now':
      return 'YYYYMMDDTHHMM — local date and minute; fresh only within its minute';
    case 'today':
      return 'YYYYMMDD — local today';
    case 'yesterday':
      return 'YYYYMMDD — local yesterday';
    case 'tomorrow':
      return 'YYYYMMDD — local tomorrow';
    case 'nextWeek':
      return 'YYYYMMDD — Monday of the next week';
    case 'currentMonth':
      return 'YYYYMM — current local month';
    case 'currentYear':
      return 'YYYY — current local year';
    default:
      return functionality;
  }
}
