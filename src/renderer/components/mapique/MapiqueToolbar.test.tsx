/**
 * P2 split (MapiqueView → mapique/MapiqueToolbar): the toolbar's disabled
 * matrix is the behavior contract worth locking down — it guards map export
 * (`save`/`saveAs`/`copyMap`) while a recursive scan or extraction batch is
 * running, and the EXIF-cache refresh while a batch is mid-flight.
 *
 * Infrastructure: node:test + global-jsdom + @testing-library/react, same as
 * MapiqueView.test.tsx but with no Leaflet / redux / DnD dependencies.
 */

import globalJsdom from 'global-jsdom';
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import i18next from 'i18next';
import type { TFunction } from 'i18next';
import * as React from 'react';

import MapiqueToolbar, {
  type MapiqueToolbarProps,
} from './MapiqueToolbar';

const t = i18next.t.bind(i18next) as unknown as TFunction;

function makeProps(
  overrides: Partial<MapiqueToolbarProps> = {}
): MapiqueToolbarProps {
  return {
    t,
    saving: false,
    loadingRecursive: false,
    readOnly: false,
    extractingActive: false,
    hasLocation: true,
    onSave: () => {},
    onSaveAs: () => {},
    onCopyMap: () => {},
    onRefreshExif: () => {},
    ...overrides,
  };
}

function renderToolbar(props: MapiqueToolbarProps) {
  return render(
    <I18nextProvider i18n={i18next} defaultNS="common">
      <MapiqueToolbar {...props} />
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

describe('MapiqueToolbar', () => {
  it('renders the four map actions', () => {
    const { getByRole } = renderToolbar(makeProps());
    assert.ok(getByRole('button', { name: 'saveImage' }));
    assert.ok(getByRole('button', { name: 'saveImageAs' }));
    assert.ok(getByRole('button', { name: 'mapiqueCopyMap' }));
    assert.ok(getByRole('button', { name: 'mapiqueRefreshExif' }));
    cleanup();
  });

  it('invokes the matching handler on click', () => {
    const calls: string[] = [];
    const { getByRole } = renderToolbar(
      makeProps({
        onSave: () => calls.push('save'),
        onSaveAs: () => calls.push('saveAs'),
        onCopyMap: () => calls.push('copyMap'),
        onRefreshExif: () => calls.push('refreshExif'),
      })
    );
    fireEvent.click(getByRole('button', { name: 'saveImage' }));
    fireEvent.click(getByRole('button', { name: 'saveImageAs' }));
    fireEvent.click(getByRole('button', { name: 'mapiqueCopyMap' }));
    fireEvent.click(getByRole('button', { name: 'mapiqueRefreshExif' }));
    assert.deepEqual(calls, ['save', 'saveAs', 'copyMap', 'refreshExif']);
    cleanup();
  });

  it('disables save / save-as / copy while saving', () => {
    const { getByRole } = renderToolbar(makeProps({ saving: true }));
    assert.equal((getByRole('button', { name: 'saveImage' }) as HTMLButtonElement).disabled, true);
    assert.equal((getByRole('button', { name: 'saveImageAs' }) as HTMLButtonElement).disabled, true);
    assert.equal((getByRole('button', { name: 'mapiqueCopyMap' }) as HTMLButtonElement).disabled, true);
    cleanup();
  });

  it('disables save / save-as in read-only mode but keeps copy enabled', () => {
    const { getByRole } = renderToolbar(makeProps({ readOnly: true }));
    assert.equal((getByRole('button', { name: 'saveImage' }) as HTMLButtonElement).disabled, true);
    assert.equal((getByRole('button', { name: 'saveImageAs' }) as HTMLButtonElement).disabled, true);
    assert.equal((getByRole('button', { name: 'mapiqueCopyMap' }) as HTMLButtonElement).disabled, false);
    cleanup();
  });

  it('disables every action while a recursive scan is running', () => {
    const { getByRole } = renderToolbar(makeProps({ loadingRecursive: true }));
    for (const name of ['saveImage', 'saveImageAs', 'mapiqueCopyMap', 'mapiqueRefreshExif']) {
      assert.equal(
        (getByRole('button', { name }) as HTMLButtonElement).disabled,
        true,
        `${name} should be disabled`
      );
    }
    cleanup();
  });

  it('keeps refresh disabled during extraction or without an open location', () => {
    const extracting = renderToolbar(makeProps({ extractingActive: true }));
    assert.equal(
      (extracting.getByRole('button', { name: 'mapiqueRefreshExif' }) as HTMLButtonElement).disabled,
      true
    );
    cleanup();

    const noLocation = renderToolbar(makeProps({ hasLocation: false }));
    assert.equal(
      (noLocation.getByRole('button', { name: 'mapiqueRefreshExif' }) as HTMLButtonElement).disabled,
      true
    );
    cleanup();
  });
});
