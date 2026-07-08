import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import extensionsReducer, {
  LOAD_EXTENSION_REGISTRY,
  loadExtensionRegistry,
  setDefaultExtension,
  setExtensionEnabled,
} from './extensions';
import type { ExtensionRegistry } from '../../shared/extension-types';

function makeRegistry(ids: string[]): ExtensionRegistry {
  return {
    extensions: ids.map((id) => ({
      id,
      name: id,
      type: 'viewer' as const,
      color: '#000',
      fileTypes: [],
      entryPoint: 'index.html',
      enabled: true,
      isDefault: true,
    })),
    generatedAt: new Date(0).toISOString(),
  };
}

describe('extensions reducer', () => {
  it('loads registry and returns it on state', () => {
    const reg = makeRegistry(['md-editor', 'pdf-viewer']);
    const state = extensionsReducer(undefined, loadExtensionRegistry(reg));
    assert.equal(state.registry, reg);
  });

  it('sets and clears userDefaults via setDefaultExtension', () => {
    let state = extensionsReducer(undefined, {
      type: 'init',
      payload: undefined,
    } as never);
    state = extensionsReducer(
      state,
      setDefaultExtension('md', 'md-editor')
    );
    assert.equal(state.userDefaults.md, 'md-editor');
    state = extensionsReducer(state, setDefaultExtension('md', null));
    assert.equal(!(state.userDefaults as Record<string, unknown>).md, true);
  });

  it('sets enabledOverrides via setExtensionEnabled', () => {
    let state = extensionsReducer(undefined, {
      type: 'init',
      payload: undefined,
    } as never);
    state = extensionsReducer(
      state,
      setExtensionEnabled('pdf-viewer', false)
    );
    assert.equal(state.enabledOverrides['pdf-viewer'], false);
  });

  describe('LOAD_EXTENSION_REGISTRY stale-state cleanup', () => {
    it('drops userDefaults whose extension id is no longer in the new registry', () => {
      // Simulate persisted state from before md-viewer was deleted: user had
      // chosen md-viewer as the default for markdown.
      const stale = extensionsReducer(undefined, {
        type: 'init',
        payload: undefined,
      } as never);
      let state = extensionsReducer(
        stale,
        setDefaultExtension('md', 'md-viewer')
      );
      state = extensionsReducer(
        state,
        setDefaultExtension('pdf', 'pdf-viewer')
      );

      // New registry no longer contains md-viewer.
      const newReg = makeRegistry(['md-editor', 'pdf-viewer']);
      const next = extensionsReducer(state, loadExtensionRegistry(newReg));

      // Orphan md→md-viewer is dropped.
      assert.equal((next.userDefaults as Record<string, unknown>).md, undefined);
      // Valid pdf→pdf-viewer survives.
      assert.equal(next.userDefaults.pdf, 'pdf-viewer');
    });

    it('drops enabledOverrides whose extension id is no longer in the new registry', () => {
      let state = extensionsReducer(undefined, {
        type: 'init',
        payload: undefined,
      } as never);
      state = extensionsReducer(
        state,
        setExtensionEnabled('md-viewer', false)
      );
      state = extensionsReducer(
        state,
        setExtensionEnabled('md-editor', true)
      );

      const newReg = makeRegistry(['md-editor']);
      const next = extensionsReducer(state, loadExtensionRegistry(newReg));

      // Orphan md-viewer override is dropped.
      assert.equal(
        (next.enabledOverrides as Record<string, unknown>)['md-viewer'],
        undefined
      );
      // Valid override survives.
      assert.equal(next.enabledOverrides['md-editor'], true);
    });

    it('keeps userDefaults / enabledOverrides untouched when all ids are still valid', () => {
      let state = extensionsReducer(undefined, {
        type: 'init',
        payload: undefined,
      } as never);
      state = extensionsReducer(
        state,
        setDefaultExtension('md', 'md-editor')
      );
      state = extensionsReducer(
        state,
        setExtensionEnabled('pdf-viewer', false)
      );

      const newReg = makeRegistry(['md-editor', 'pdf-viewer']);
      const next = extensionsReducer(state, loadExtensionRegistry(newReg));

      assert.equal(next.userDefaults.md, 'md-editor');
      assert.equal(next.enabledOverrides['pdf-viewer'], false);
    });

    it('a null payload only clears the registry reference, not persisted state', () => {
      // When the registry load fails (extension-api throws), we set null.
      // Persisted userDefaults/enabledOverrides stay intact so the next
      // successful reload can reuse them.
      let state = extensionsReducer(undefined, {
        type: 'init',
        payload: undefined,
      } as never);
      state = extensionsReducer(
        state,
        setDefaultExtension('md', 'md-editor')
      );
      state = extensionsReducer(state, setExtensionEnabled('md-editor', true));

      const next = extensionsReducer(state, loadExtensionRegistry(null));

      assert.equal(next.registry, null);
      assert.equal(next.userDefaults.md, 'md-editor');
      assert.equal(next.enabledOverrides['md-editor'], true);
    });
  });

  it('ignores unknown action types and returns current state', () => {
    const reg = makeRegistry(['md-editor']);
    const state = extensionsReducer(undefined, loadExtensionRegistry(reg));
    const next = extensionsReducer(
      state,
      { type: 'extensions/SOMETHING_UNKNOWN' } as never
    );
    assert.equal(next, state);
  });
});