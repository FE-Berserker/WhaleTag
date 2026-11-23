import globalJsdom from 'global-jsdom';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
type TestingLibrary = typeof import('@testing-library/react');
let cleanup: TestingLibrary['cleanup'];
let fireEvent: TestingLibrary['fireEvent'];
let render: TestingLibrary['render'];
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
let Provider: typeof import('react-redux').Provider;
import { createStore } from 'redux';

import type { WorkflowStage } from '../domain/workflow';

let WorkflowManagerDialog: typeof import('./WorkflowManagerDialog').default;
let cleanupDom: (() => void) | undefined;
before(async () => {
  cleanupDom = globalJsdom();
  ({ Provider } = await import('react-redux'));
  ({ cleanup, fireEvent, render } = await import('@testing-library/react'));
  WorkflowManagerDialog = (await import('./WorkflowManagerDialog')).default;
  if (typeof document !== 'undefined' && !document.body) {
    const body = document.createElement('body');
    document.documentElement?.appendChild(body);
  }
  await i18next.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: {} } },
  });
});
afterEach(() => cleanup());
after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  cleanupDom?.();
});

interface RecordedAction {
  type: string;
  payload?: unknown;
}

function renderDialog(stages: WorkflowStage[] = []) {
  const actions: RecordedAction[] = [];
  const initialState = {
    workflow: { stages },
    settings: { tagShape: 'rounded', tagColors: {} },
  };
  const store = createStore(
    (state = initialState, action: RecordedAction) => {
      if (!action.type.startsWith('@@redux/')) actions.push(action);
      return state;
    }
  );
  const view = render(
    <Provider store={store}>
      <I18nextProvider i18n={i18next}>
        <WorkflowManagerDialog open onClose={() => undefined} />
      </I18nextProvider>
    </Provider>
  );
  return { view, actions };
}

describe('WorkflowManagerDialog IME commits', () => {
  it('does not add a stage for a composing Enter', () => {
    const { view, actions } = renderDialog();
    const input = view.getByPlaceholderText('stageName') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Review' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    assert.deepEqual(actions, []);
    assert.equal(input.value, 'Review');

    fireEvent.keyDown(input, { key: 'Enter' });
    assert.equal(actions.length, 2);
    assert.equal(input.value, '');
  });

  it('does not blur and rename a stage for a composing Enter', () => {
    const { view, actions } = renderDialog([
      { id: 'stage-1', value: 'Doing', color: '#000000' },
    ]);
    const input = view.getByDisplayValue('Doing') as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: 'Done' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    assert.deepEqual(actions, []);
    assert.equal(document.activeElement, input);

    fireEvent.keyDown(input, { key: 'Enter' });
    assert.equal(actions.length, 2);
    assert.notEqual(document.activeElement, input);
  });
});

describe('WorkflowManagerDialog keyboard controls', () => {
  it('changes the tag shape from the keyboard', () => {
    const { view, actions } = renderDialog();
    const shape = view.getByText('shape_rounded');

    fireEvent.keyDown(shape, { key: 'Enter' });
    assert.deepEqual(actions.at(-1), {
      type: 'settings/SET_TAG_SHAPE',
      payload: 'rounded',
    });

    fireEvent.keyDown(shape, { key: ' ' });
    assert.equal(
      actions.filter((action) => action.type === 'settings/SET_TAG_SHAPE')
        .length,
      2
    );
  });

  it('opens the stage color palette from the keyboard', async () => {
    const { view } = renderDialog([
      { id: 'stage-1', value: 'Doing', color: '#123456' },
    ]);
    const dot = view.getByRole('button', { name: 'changeColor' });
    fireEvent.keyDown(dot, { key: 'Enter' });

    await view.findByRole('menu');
    assert.ok(view.getAllByRole('menuitem').length > 0);
  });
});
