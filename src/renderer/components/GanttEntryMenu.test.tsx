/**
 * GanttEntryMenu tests — minimal smoke coverage. The full parallel menu
 * suite lives in KanbanEntryMenu.test.tsx; this file just verifies the
 * Gantt-specific section wiring (data-testids, "Clear period" gating on
 * period presence, Open / Delete / More handlers).
 */

import globalJsdom from 'global-jsdom';

import { afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { Provider } from 'react-redux';
import { createStore } from 'redux';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import i18next from 'i18next';

import GanttEntryMenu, {
  type GanttEntryContext,
} from './GanttEntryMenu';
import { PeriodTagDialogProvider } from './PeriodTagDialog';
import type { DirEntry } from '../../shared/ipc-types';
import type { TagGroup } from '../domain/tag-library';
import type { TFunction } from 'i18next';

const STUB_T: TFunction = ((key: string) => key) as TFunction;

function entry(name: string): DirEntry {
  const dot = name.lastIndexOf('.');
  return {
    name,
    path: `/root/${name}`,
    isFile: true,
    isDirectory: false,
    size: 0,
    modified: '1970-01-01T00:00:00.000Z',
    extension: dot >= 0 ? name.slice(dot + 1).toLowerCase() : '',
  };
}

const GROUPS: TagGroup[] = [
  {
    id: 'g-workflow',
    title: 'Workflow',
    expanded: true,
    color: '#008000',
    tags: ['not-started', 'in-progress', 'completed'],
  },
];

const STUB_STORE = createStore(() => ({}));

function renderMenu(props: Partial<React.ComponentProps<typeof GanttEntryMenu>> & {
  ctx: GanttEntryContext | null;
  currentTags: string[];
  sources?: DirEntry[];
  readOnly?: boolean;
}) {
  const { ctx, currentTags, sources, readOnly = false, ...rest } = props;
  const single = ctx?.entry ?? entry('a.txt');
  const allSources = sources ?? [single];
  return render(
    <I18nextProvider i18n={i18next} defaultNS="common">
      <Provider store={STUB_STORE}>
        <DndProvider backend={HTML5Backend}>
          <PeriodTagDialogProvider>
            <GanttEntryMenu
              ctx={ctx}
              onClose={() => {}}
              stageValues={['not-started', 'in-progress', 'completed']}
              tagColors={{}}
              groups={GROUPS}
              sources={allSources}
              currentTags={currentTags}
              t={STUB_T}
              readOnly={readOnly}
              onMoveToColumn={() => {}}
              onAddTag={() => {}}
              onRemoveTag={() => {}}
              onSetEntryDateTag={() => {}}
              onRemoveEntryDateTag={() => {}}
              onOpen={() => {}}
              onDelete={() => {}}
              onMoreFileActions={() => {}}
              {...rest}
            />
          </PeriodTagDialogProvider>
        </DndProvider>
      </Provider>
    </I18nextProvider>
  );
}

before(async () => {
  globalJsdom();
  await i18next.use(initReactI18next).init({
    resources: { en: { common: {} } },
    lng: 'en',
    fallbackLng: 'en',
    defaultNS: 'common',
    ns: ['common'],
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});

describe('GanttEntryMenu #1: section wiring', () => {
  it('renders the five gantt-* MenuItems when ctx is open', () => {
    const ctx: GanttEntryContext = {
      x: 10,
      y: 10,
      entry: entry('a.txt'),
    };
    const { getByTestId } = renderMenu({ ctx, currentTags: [] });
    assert.ok(getByTestId('gantt-open-stage'));
    assert.ok(getByTestId('gantt-open-priority'));
    assert.ok(getByTestId('gantt-open-period'));
    assert.ok(getByTestId('gantt-clear-period'));
    assert.ok(getByTestId('gantt-edit-tags'));
    assert.ok(getByTestId('gantt-open'));
    assert.ok(getByTestId('gantt-delete'));
    assert.ok(getByTestId('gantt-more'));
  });

  it('disables "Clear period" when no period tag is present', () => {
    const ctx: GanttEntryContext = {
      x: 10,
      y: 10,
      entry: entry('a.txt'),
    };
    const { getByTestId } = renderMenu({
      ctx,
      currentTags: ['idea'],
    });
    const clear = getByTestId('gantt-clear-period') as HTMLLIElement;
    // MUI MenuItem uses `aria-disabled="true"` (not the HTML `disabled`
    // attribute) so the underlying button remains focusable for keyboard
    // users — same pattern KanbanEntryMenu's tests rely on.
    assert.equal(clear.getAttribute('aria-disabled'), 'true');
  });

  it('enables "Clear period" when a period tag is present', () => {
    const ctx: GanttEntryContext = {
      x: 10,
      y: 10,
      entry: entry('a.txt'),
    };
    const { getByTestId } = renderMenu({
      ctx,
      currentTags: ['20260704-20260710'],
    });
    const clear = getByTestId('gantt-clear-period') as HTMLLIElement;
    assert.equal(clear.getAttribute('aria-disabled'), null);
  });

  it('disables the write sections when readOnly', () => {
    const ctx: GanttEntryContext = {
      x: 10,
      y: 10,
      entry: entry('a.txt'),
    };
    const { getByTestId } = renderMenu({
      ctx,
      currentTags: ['20260704-20260710'],
      readOnly: true,
    });
    const moveStage = getByTestId('gantt-open-stage') as HTMLLIElement;
    const openPeriod = getByTestId('gantt-open-period') as HTMLLIElement;
    const del = getByTestId('gantt-delete') as HTMLLIElement;
    assert.equal(moveStage.getAttribute('aria-disabled'), 'true');
    assert.equal(openPeriod.getAttribute('aria-disabled'), 'true');
    assert.equal(del.getAttribute('aria-disabled'), 'true');
  });

  // P0 #5/#6: when the user has narrowed the workflow / quadrant
  // filter and the right-clicked source sits in a selection that
  // includes a filtered-out entry, the view passes hasFilteredSource
  // and the menu must gate its write actions. "Open" stays enabled
  // (reading a hidden row is fine) — only writes are blocked.
  it('disables write sections when hasFilteredSource is true', () => {
    const ctx: GanttEntryContext = {
      x: 10,
      y: 10,
      entry: entry('a.txt'),
    };
    const { getByTestId } = renderMenu({
      ctx,
      currentTags: ['20260704-20260710'],
      hasFilteredSource: true,
    });
    const moveStage = getByTestId('gantt-open-stage') as HTMLLIElement;
    const setPriority = getByTestId('gantt-open-priority') as HTMLLIElement;
    const openPeriod = getByTestId('gantt-open-period') as HTMLLIElement;
    const clearPeriod = getByTestId('gantt-clear-period') as HTMLLIElement;
    const del = getByTestId('gantt-delete') as HTMLLIElement;
    assert.equal(moveStage.getAttribute('aria-disabled'), 'true');
    assert.equal(setPriority.getAttribute('aria-disabled'), 'true');
    assert.equal(openPeriod.getAttribute('aria-disabled'), 'true');
    assert.equal(clearPeriod.getAttribute('aria-disabled'), 'true');
    assert.equal(del.getAttribute('aria-disabled'), 'true');
  });

  it('leaves "Open" enabled even when hasFilteredSource is true', () => {
    // Reading a hidden row shouldn't be blocked — the user might
    // want to inspect it before deciding whether to clear the
    // filter. Only writes are gated.
    const ctx: GanttEntryContext = {
      x: 10,
      y: 10,
      entry: entry('a.txt'),
    };
    const { getByTestId } = renderMenu({
      ctx,
      currentTags: [],
      hasFilteredSource: true,
    });
    const openItem = getByTestId('gantt-open') as HTMLLIElement;
    assert.notEqual(openItem.getAttribute('aria-disabled'), 'true');
  });
});

describe('GanttEntryMenu #2: action dispatch', () => {
  it('routes "Open" through onOpen with the right-clicked entry', () => {
    let opened: DirEntry | null = null;
    const e = entry('a.txt');
    const ctx: GanttEntryContext = { x: 1, y: 2, entry: e };
    const { getByTestId } = renderMenu({
      ctx,
      currentTags: [],
      onOpen: (entry) => {
        opened = entry;
      },
    });
    fireEvent.click(getByTestId('gantt-open'));
    assert.equal(opened?.path, e.path);
  });

  it('routes "Delete" through onDelete', () => {
    let deleted: DirEntry | null = null;
    const e = entry('a.txt');
    const ctx: GanttEntryContext = { x: 1, y: 2, entry: e };
    const { getByTestId } = renderMenu({
      ctx,
      currentTags: [],
      onDelete: (entry) => {
        deleted = entry;
      },
    });
    fireEvent.click(getByTestId('gantt-delete'));
    assert.equal(deleted?.path, e.path);
  });

  it('routes "Clear period" through onRemoveEntryDateTag', () => {
    let clearedFor: DirEntry | null = null;
    const e = entry('a.txt');
    const ctx: GanttEntryContext = { x: 1, y: 2, entry: e };
    const { getByTestId } = renderMenu({
      ctx,
      currentTags: ['20260704-20260710'],
      onRemoveEntryDateTag: (entry) => {
        clearedFor = entry;
      },
    });
    fireEvent.click(getByTestId('gantt-clear-period'));
    assert.equal(clearedFor?.path, e.path);
  });
});

afterEach(() => {
  cleanup();
});