import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import globalJsdom from 'global-jsdom';
import type { LanClient } from './api';
import { LanApiError } from './api';
import { createRequestScope, REQUEST_TIMEOUT_MS } from './request';
import type { AppProps } from './App';
import type { LanEntry, LanListResponse, LanRoot, LanSearchResponse } from '../shared/lan-types';

const docs: LanRoot = { id: 'root', name: 'Docs' };
const second: LanRoot = { id: 'second', name: 'Second' };

function entry(overrides: Partial<LanEntry> = {}): LanEntry {
  return {
    id: 'notes', rootId: 'root', name: 'notes.txt', path: '/notes.txt',
    isDirectory: false, size: 12, modified: '2026-01-02T03:04:05.000Z',
    extension: 'txt', tags: [], ...overrides,
  };
}

function makeClient(overrides: Partial<LanClient> = {}, existingSession = false): LanClient {
  let authenticated = existingSession;
  const pair = overrides.pair ?? (async () => undefined);
  const roots = overrides.roots ?? (async () => ({ roots: [docs] }));
  return {
    pair: async (token, signal) => {
      await pair(token, signal);
      authenticated = true;
    },
    roots: async (signal) => {
      if (!authenticated) throw new LanApiError(401);
      return roots(signal);
    },
    list: overrides.list ?? (async () => ({
      rootId: 'root', id: '', name: 'Docs', path: '/', parentId: null, entries: [],
    })),
    tags: overrides.tags ?? (async () => ({ tags: [], indexUnavailable: false })),
    search: overrides.search ?? (async () => ({ entries: [], indexUnavailable: false })),
    probe: overrides.probe ?? (async () => undefined),
    text: overrides.text ?? (async () => ({ text: '', truncated: false })),
  };
}

describe('mobile read-only app', () => {
  let teardown: () => void;
  let rtl: typeof import('@testing-library/react');
  let App: typeof import('./App').default;
  let previewKind: typeof import('./App').previewKind;

  before(async () => {
    teardown = globalJsdom('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'http://localhost/mobile.html',
    });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    rtl = await import('@testing-library/react');
    ({ default: App, previewKind } = await import('./App'));
  });

  afterEach(() => {
    rtl.cleanup();
    window.history.replaceState(null, '', '/mobile.html');
  });

  after(() => {
    teardown();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderPaired(client: LanClient, props: Partial<AppProps> = {}) {
    const result = rtl.render(<App client={client} initialLanguage="en" {...props} />);
    rtl.fireEvent.change(await rtl.screen.findByLabelText('Pairing token'), { target: { value: 'secret' } });
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Connect' }));
    await rtl.screen.findByRole('combobox', { name: 'Select a location' });
    return result;
  }

  it('classifies safe previews and never inlines active or PDF content', () => {
    assert.equal(previewKind(entry({ extension: 'png' })), 'image');
    assert.equal(previewKind(entry({ extension: '.MP4' })), 'video');
    assert.equal(previewKind(entry({ extension: 'mp3' })), 'audio');
    assert.equal(previewKind(entry({ extension: 'txt' })), 'text');
    assert.equal(previewKind(entry({ extension: 'pdf' })), 'pdf');
    for (const extension of ['svg', 'html', 'htm', 'xml', 'js', 'mjs']) {
      assert.equal(previewKind(entry({ extension })), 'unsupported', extension);
    }
  });

  it('pairs from the URL fragment and removes the token before the request settles', async () => {
    let finishPair!: () => void;
    const pairing = new Promise<void>((resolve) => { finishPair = resolve; });
    const tokens: string[] = [];
    const base = makeClient({ pair: (token) => { tokens.push(token); return pairing; } });
    let rootAttempts = 0;
    const client: LanClient = {
      ...base,
      roots: async (signal) => {
        rootAttempts += 1;
        return base.roots(signal);
      },
    };
    window.location.hash = '#token=fragment%20secret';
    rtl.render(<App client={client} initialLanguage="en" />);
    await rtl.waitFor(() => assert.deepEqual(tokens, ['fragment secret']));
    assert.equal(window.location.hash, '');
    assert.equal(rootAttempts, 0, 'auto-pair must not race an unauthenticated roots probe');
    assert.equal(rtl.screen.queryByRole('combobox', { name: 'Select a location' }), null);
    finishPair();
    await rtl.screen.findByText('This folder is empty.');
    assert.equal(rootAttempts, 1);
  });

  it('restores a valid cookie session without asking for the token again', async () => {
    let finishRoots!: () => void;
    let pairCalls = 0;
    let rootsCalls = 0;
    const roots = new Promise<void>((resolve) => { finishRoots = resolve; });
    const client = makeClient({
      pair: async () => { pairCalls += 1; },
      roots: async () => { rootsCalls += 1; await roots; return { roots: [docs] }; },
    }, true);
    rtl.render(<App client={client} initialLanguage="en" />);
    await rtl.waitFor(() => assert.equal(rootsCalls, 1));
    assert.equal(rtl.screen.getByLabelText('Loading…').getAttribute('aria-label'), 'Loading…');
    assert.equal(rtl.screen.queryByLabelText('Pairing token'), null);
    finishRoots();
    await rtl.screen.findByText('This folder is empty.');
    assert.equal(pairCalls, 0);
    assert.equal(rootsCalls, 1);
  });

  it('shows manual pairing failures without loading roots', async () => {
    let rootsCalled = false;
    const client = makeClient({
      pair: async () => { throw new LanApiError(401); },
      roots: async () => { rootsCalled = true; return { roots: [docs] }; },
    });
    rtl.render(<App client={client} initialLanguage="en" />);
    rtl.fireEvent.change(await rtl.screen.findByLabelText('Pairing token'), { target: { value: 'bad' } });
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Connect' }));
    await rtl.screen.findByText('Pairing failed. Check the token and try again.');
    assert.equal(rootsCalled, false);
  });

  it('navigates deep folders with a complete breadcrumb trail and retries failed loads', async () => {
    const folder = entry({ id: 'folder', name: 'Folder', isDirectory: true, extension: '', size: 0 });
    const nested = entry({ id: 'nested', name: 'Nested', isDirectory: true, extension: '', size: 0 });
    const directoryIds: Array<string | undefined> = [];
    let failNext = true;
    const client = makeClient({
      list: async (_rootId, id) => {
        directoryIds.push(id);
        if (failNext) {
          failNext = false;
          throw new LanApiError(500);
        }
        return {
          rootId: 'root', id: id ?? '', name: id === 'nested' ? 'Nested' : id ? 'Folder' : 'Docs', path: '/', parentId: null,
          entries: id === 'nested' ? [] : id === 'folder' ? [nested] : [folder],
        };
      },
    });
    await renderPaired(client);
    await rtl.screen.findByText('Could not load this content. Check the connection and try again.');
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Retry' }));
    rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Open: Folder' }));
    rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Open: Nested' }));
    await rtl.screen.findByText('This folder is empty.');
    let navigation = rtl.screen.getByRole('navigation', { name: 'Folders' });
    assert.ok(rtl.within(navigation).getByText('Folder'));
    assert.ok(rtl.within(navigation).getByText('Nested'));
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Back' }));
    await rtl.screen.findByRole('button', { name: 'Open: Nested' });
    navigation = rtl.screen.getByRole('navigation', { name: 'Folders' });
    assert.equal(rtl.within(navigation).queryByText('Nested'), null);
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Open: Nested' }));
    await rtl.screen.findByText('This folder is empty.');
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Folder' }));
    await rtl.screen.findByRole('button', { name: 'Open: Nested' });
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Docs' }));
    await rtl.screen.findByRole('button', { name: 'Open: Folder' });
    assert.deepEqual(directoryIds, [undefined, undefined, 'folder', 'nested', 'folder', 'nested', 'folder', undefined]);
  });

  it('debounces combined name/tag search, exposes index state, and switches layout', async () => {
    const calls: Array<{ query: string; tag: string }> = [];
    const client = makeClient({
      list: async () => ({
        rootId: 'root', id: '', name: 'Docs', path: '/', parentId: null,
        entries: [entry()],
      }),
      tags: async () => ({ tags: ['work'], indexUnavailable: false }),
      search: async (_rootId, query, tag) => {
        calls.push({ query, tag });
        return { entries: [entry()], indexUnavailable: true };
      },
    });
    await renderPaired(client);
    await rtl.screen.findByRole('button', { name: 'Open: notes.txt' });
    await rtl.screen.findByRole('button', { name: 'work' });
    assert.ok(rtl.screen.getByRole('group', { name: 'Tags' }));
    rtl.fireEvent.change(rtl.screen.getByLabelText('Search files and folders'), { target: { value: 'report' } });
    assert.equal(calls.length, 0);
    await rtl.waitFor(() => assert.deepEqual(calls, [{ query: 'report', tag: '' }]), { timeout: 1500 });
    await rtl.screen.findByText('Search and tags are unavailable until the desktop app builds its index.');
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'work' }));
    await rtl.waitFor(() => assert.deepEqual(calls[1], { query: 'report', tag: 'work' }), { timeout: 1500 });
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Grid view' }));
    assert.equal(rtl.screen.getByRole('button', { name: 'Grid view' }).getAttribute('aria-pressed'), 'true');
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Clear search and tag filter' }));
    await rtl.waitFor(() => assert.equal(calls.length, 2));
  });

  it('switches roots and resets the current location', async () => {
    const rootsSeen: string[] = [];
    const client = makeClient({
      roots: async () => ({ roots: [docs, second] }),
      list: async (rootId) => {
        rootsSeen.push(rootId);
        return { rootId, id: '', name: rootId, path: '/', parentId: null, entries: [] };
      },
    });
    await renderPaired(client);
    await rtl.screen.findByText('This folder is empty.');
    rtl.fireEvent.mouseDown(rtl.screen.getByRole('combobox', { name: 'Select a location' }));
    rtl.fireEvent.click(await rtl.screen.findByRole('option', { name: 'Second' }));
    await rtl.waitFor(() => assert.equal(rtl.screen.getByRole('combobox', { name: 'Select a location' }).textContent, 'Second'));
    assert.deepEqual(rootsSeen, ['root', 'second']);
  });

  it('shows directory warnings and clears them for search and subfolder navigation', async () => {
    const truncationWarning = 'Only the first 500 entries are shown. Open a subfolder or search to narrow the results.';
    const metadataWarning = 'Tag metadata is damaged or unreadable. Files are listed, but sidecar tags may be incomplete.';
    const folder = entry({ id: 'folder', name: 'Folder', isDirectory: true, extension: '', size: 0 });
    let searchCalls = 0;
    const client = makeClient({
      list: async (_rootId, id) => ({
        rootId: 'root', id: id ?? '', name: id ? 'Folder' : 'Docs', path: '/', parentId: null,
        entries: id ? [] : [folder],
        ...(id ? {} : { truncated: true, metadataUnavailable: true }),
      }),
      search: async () => {
        searchCalls += 1;
        return { entries: [], indexUnavailable: false };
      },
    });
    await renderPaired(client);
    await rtl.screen.findByText(truncationWarning);
    await rtl.screen.findByText(metadataWarning);
    rtl.fireEvent.change(rtl.screen.getByLabelText('Search files and folders'), { target: { value: 'report' } });
    await rtl.waitFor(() => {
      assert.equal(rtl.screen.queryByText(truncationWarning), null);
      assert.equal(rtl.screen.queryByText(metadataWarning), null);
    });
    await rtl.waitFor(() => assert.equal(searchCalls, 1));
    assert.equal(rtl.screen.queryByText(truncationWarning), null);
    assert.equal(rtl.screen.queryByText(metadataWarning), null);
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Clear search and tag filter' }));
    await rtl.screen.findByText(truncationWarning);
    await rtl.screen.findByText(metadataWarning);
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Open: Folder' }));
    await rtl.screen.findByText('This folder is empty.');
    assert.equal(rtl.screen.queryByText(truncationWarning), null);
    assert.equal(rtl.screen.queryByText(metadataWarning), null);
  });

  it('shows bounded truncated text and keeps download available', async () => {
    let textCalls = 0;
    const client = makeClient({
      list: async () => ({
        rootId: 'root', id: '', name: 'Docs', path: '/', parentId: null,
        entries: [entry({ size: 10 * 1024 * 1024 })],
      }),
      text: async () => { textCalls += 1; return { text: 'partial text', truncated: true }; },
    });
    await renderPaired(client);
    rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Open: notes.txt' }));
    await rtl.screen.findByText('partial text');
    await rtl.screen.findByText('Only the first 256 KiB is shown. Download the file to view all of it.');
    const download = rtl.screen.getByRole('link', { name: 'Download' }) as HTMLAnchorElement;
    assert.equal(download.getAttribute('href'), '/api/file?rootId=root&id=notes&download=1');
    assert.equal(textCalls, 1);
  });

  it('shows raster thumbnails and falls back to an icon without inlining active content', async () => {
    const photo = entry({ id: 'photo', name: 'photo.png', extension: 'png' });
    const vector = entry({ id: 'vector', name: 'vector.svg', extension: 'svg' });
    const page = entry({ id: 'page', name: 'page.html', extension: 'html' });
    const documentEntry = entry({ id: 'doc', name: 'report.docx', extension: '.docx' });
    const client = makeClient({
      list: async () => ({
        rootId: 'root', id: '', name: 'Docs', path: '/', parentId: null,
        entries: [photo, vector, page, documentEntry],
      }),
    });
    await renderPaired(client);
    const photoButton = await rtl.screen.findByRole('button', { name: 'Open: photo.png' });
    const thumbnail = photoButton.querySelector('img');
    assert.ok(thumbnail);
    assert.equal(thumbnail.getAttribute('src'), '/api/file?rootId=root&id=photo');
    assert.equal(rtl.screen.getByRole('button', { name: 'Open: vector.svg' }).querySelector('img'), null);
    assert.equal(rtl.screen.getByRole('button', { name: 'Open: page.html' }).querySelector('img'), null);
    const documentButton = rtl.screen.getByRole('button', { name: 'Open: report.docx' });
    assert.ok(rtl.within(documentButton).getByText('DOCX'));
    rtl.fireEvent.error(thumbnail);
    await rtl.waitFor(() => assert.equal(photoButton.querySelector('img'), null));
    assert.ok(photoButton.querySelector('.entry-type-icon'));
  });

  it('uses streaming media URLs and safe download-only fallbacks', async () => {
    const image = entry({ id: 'image', name: 'photo.png', extension: 'png' });
    const pdf = entry({ id: 'pdf', name: 'manual.pdf', extension: 'pdf' });
    const client = makeClient({
      list: async () => ({
        rootId: 'root', id: '', name: 'Docs', path: '/', parentId: null, entries: [image, pdf],
      }),
    });
    await renderPaired(client);
    rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Open: photo.png' }));
    const imageElement = await rtl.screen.findByAltText('photo.png');
    assert.equal(imageElement.getAttribute('src'), '/api/file?rootId=root&id=image');
    assert.equal(document.querySelector('iframe, object, embed'), null);
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Close preview' }));
    rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Open: manual.pdf' }));
    await rtl.screen.findByText('PDF preview is disabled for safety. Download the file to view it.');
    assert.equal(document.querySelector('iframe, object, embed'), null);
    assert.equal(
      rtl.screen.getByRole('link', { name: 'Download' }).getAttribute('href'),
      '/api/file?rootId=root&id=pdf&download=1',
    );
  });

  it('resets pending text loading before opening another media preview', async () => {
    const notes = entry();
    const image = entry({ id: 'image', name: 'photo.png', extension: 'png' });
    let resolveText: ((value: { text: string; truncated: boolean }) => void) | undefined;
    const client = makeClient({
      list: async () => ({
        rootId: 'root', id: '', name: 'Docs', path: '/', parentId: null, entries: [notes, image],
      }),
      text: () => new Promise((resolve) => { resolveText = resolve; }),
    });
    await renderPaired(client);
    rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Open: notes.txt' }));
    await rtl.screen.findByRole('progressbar');
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Close preview' }));
    rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Open: photo.png' }));
    const media = await rtl.screen.findByAltText('photo.png');
    assert.equal(media.getAttribute('src'), '/api/file?rootId=root&id=image');
    assert.equal(rtl.screen.queryByRole('progressbar'), null);
    resolveText?.({ text: 'late text', truncated: false });
  });

  it('makes folder searches root-wide and restores the root when filters clear', async () => {
    const folder = entry({ id: 'folder', name: 'Folder', isDirectory: true, extension: '', size: 0 });
    const result = entry({ id: 'result', name: 'report.txt', extension: 'txt' });
    const directoryIds: Array<string | undefined> = [];
    const client = makeClient({
      list: async (_rootId, id) => {
        directoryIds.push(id);
        return {
          rootId: 'root', id: id ?? '', name: id ? 'Folder' : 'Docs', path: '/', parentId: null,
          entries: id ? [] : [folder],
        };
      },
      search: async () => ({ entries: [result], indexUnavailable: false }),
    });
    await renderPaired(client);
    rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Open: Folder' }));
    await rtl.screen.findByText('This folder is empty.');
    rtl.fireEvent.change(rtl.screen.getByLabelText('Search files and folders'), { target: { value: 'report' } });
    await rtl.screen.findByRole('button', { name: 'Open: report.txt' });
    assert.ok(rtl.screen.getByText('1 item'));
    assert.equal(rtl.screen.queryByText('1 items'), null);
    assert.equal(rtl.screen.queryByRole('navigation', { name: 'Folders' }), null);
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Clear search and tag filter' }));
    await rtl.screen.findByRole('button', { name: 'Open: Folder' });
    assert.deepEqual(directoryIds, [undefined, 'folder', undefined]);
  });

  it('keeps the selected location aligned when search opens a folder from another root', async () => {
    const localFolder = entry({ id: 'folder', name: 'Folder', isDirectory: true, extension: '', size: 0 });
    const remoteFolder = entry({ id: 'remote', rootId: 'second', name: 'Remote', isDirectory: true, extension: '', size: 0 });
    const requests: string[] = [];
    const client = makeClient({
      roots: async () => ({ roots: [docs, second] }),
      list: async (rootId, id) => {
        requests.push(`${rootId}:${id ?? ''}`);
        return {
          rootId, id: id ?? '', name: id ?? rootId, path: '/', parentId: null,
          entries: rootId === 'root' && !id ? [localFolder] : [],
        };
      },
      search: async () => ({ entries: [remoteFolder], indexUnavailable: false }),
    });
    await renderPaired(client);
    rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Open: Folder' }));
    await rtl.screen.findByText('This folder is empty.');
    rtl.fireEvent.change(rtl.screen.getByLabelText('Search files and folders'), { target: { value: 'remote' } });
    rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Open: Remote' }));
    await rtl.screen.findByText('This folder is empty.');
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Back' }));
    await rtl.screen.findByText('This folder is empty.');
    assert.equal(rtl.screen.getByRole('combobox', { name: 'Select a location' }).textContent, 'Second');
    assert.deepEqual(requests, ['root:', 'root:folder', 'second:remote', 'second:']);
  });

  it('returns an established session to pairing when listing receives 401', async () => {
    const client = makeClient({ list: async () => { throw new LanApiError(401); } });
    rtl.render(<App client={client} initialLanguage="en" />);
    rtl.fireEvent.change(await rtl.screen.findByLabelText('Pairing token'), { target: { value: 'token' } });
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Connect' }));
    await rtl.screen.findByText('Your session expired. Pair again to continue.');
    assert.ok(rtl.screen.getByLabelText('Pairing token'));
  });

  it('returns an established session to pairing when tags receive 401', async () => {
    const client = makeClient({ tags: async () => { throw new LanApiError(401); } });
    rtl.render(<App client={client} initialLanguage="en" />);
    rtl.fireEvent.change(await rtl.screen.findByLabelText('Pairing token'), { target: { value: 'token' } });
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Connect' }));
    await rtl.screen.findByText('Your session expired. Pair again to continue.');
    assert.ok(rtl.screen.getByLabelText('Pairing token'));
  });

  it('handles preview failures without leaking errors and expires text-preview sessions', async () => {
    let unauthorized = false;
    const client = makeClient({
      list: async () => ({
        rootId: 'root', id: '', name: 'Docs', path: '/', parentId: null, entries: [entry()],
      }),
      text: async () => {
        if (unauthorized) throw new LanApiError(401);
        throw new Error('sensitive disk path');
      },
    });
    await renderPaired(client);
    rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Open: notes.txt' }));
    await rtl.screen.findByText('The preview could not be loaded. You can download the file instead.');
    assert.equal(rtl.screen.queryByText('sensitive disk path'), null);
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Close preview' }));
    unauthorized = true;
    rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Open: notes.txt' }));
    await rtl.screen.findByText('Your session expired. Pair again to continue.');
    assert.ok(rtl.screen.getByLabelText('Pairing token'));
  });

  it('does not refetch roots or directory contents when only the language changes', async () => {
    let rootsCalls = 0;
    let listCalls = 0;
    const client = makeClient({
      roots: async () => { rootsCalls += 1; return { roots: [{ id: 'root', name: 'Docs', path: '/' }] }; },
      list: async () => {
        listCalls += 1;
        return { rootId: 'root', id: '', name: 'Docs', path: '/', parentId: null, entries: [] };
      },
    });
    await renderPaired(client);
    await rtl.screen.findByText('This folder is empty.');
    await rtl.act(async () => {
      rtl.fireEvent.mouseDown(rtl.screen.getByRole('combobox', { name: 'Language' }));
    });
    const simplifiedChinese = await rtl.screen.findByRole('option', { name: '简体中文' });
    await rtl.act(async () => {
      rtl.fireEvent.click(simplifiedChinese);
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    await rtl.screen.findByText('此文件夹为空。');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(rootsCalls, 1);
    assert.equal(listCalls, 1);
  });

  it('flags timed-out request scopes and cancels cleanly', async () => {
    assert.equal(REQUEST_TIMEOUT_MS, 15_000);
    const timed = createRequestScope(20);
    await new Promise<void>((resolve) => {
      timed.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    assert.equal(timed.signal.aborted, true);
    assert.equal(timed.timedOut, true);
    timed.dispose();

    const cancelled = createRequestScope(10_000);
    cancelled.cancel();
    assert.equal(cancelled.signal.aborted, true);
    assert.equal(cancelled.timedOut, false);
  });

  it('degrades image, video, and audio previews that fail to load', async () => {
    const items = [
      entry({ id: 'image', name: 'photo.png', extension: 'png' }),
      entry({ id: 'clip', name: 'clip.mp4', extension: 'mp4' }),
      entry({ id: 'track', name: 'track.mp3', extension: 'mp3' }),
    ];
    const client = makeClient({
      list: async () => ({
        rootId: 'root', id: '', name: 'Docs', path: '/', parentId: null, entries: items,
      }),
    });
    await renderPaired(client);
    const previewError = 'The preview could not be loaded. You can download the file instead.';

    rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Open: photo.png' }));
    rtl.fireEvent.error(await rtl.screen.findByAltText('photo.png'));
    await rtl.screen.findByText(previewError);
    assert.ok(document.querySelector('.preview-media-fallback'));
    assert.equal(rtl.screen.queryByAltText('photo.png'), null);
    assert.equal(
      rtl.screen.getByRole('link', { name: 'Download' }).getAttribute('href'),
      '/api/file?rootId=root&id=image&download=1',
    );
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Close preview' }));

    rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Open: clip.mp4' }));
    const video = document.querySelector('video');
    assert.ok(video);
    rtl.fireEvent.error(video);
    await rtl.waitFor(() => assert.equal(document.querySelector('video'), null));
    assert.ok(document.querySelector('.preview-media-fallback'));
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Close preview' }));

    rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Open: track.mp3' }));
    const audio = document.querySelector('audio');
    assert.ok(audio);
    rtl.fireEvent.error(audio);
    await rtl.waitFor(() => assert.equal(document.querySelector('audio'), null));
    assert.ok(document.querySelector('.preview-media-fallback'));
  });

  it('returns to pairing when a failed media preview probes as 401', async () => {
    const image = entry({ id: 'image', name: 'photo.png', extension: 'png' });
    const client = makeClient({
      list: async () => ({
        rootId: 'root', id: '', name: 'Docs', path: '/', parentId: null, entries: [image],
      }),
      probe: async () => { throw new LanApiError(401); },
    });
    await renderPaired(client);
    rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: 'Open: photo.png' }));
    rtl.fireEvent.error(await rtl.screen.findByAltText('photo.png'));
    await rtl.screen.findByText('Your session expired. Pair again to continue.');
    assert.ok(rtl.screen.getByLabelText('Pairing token'));
  });

  it('aborts superseded search requests and ignores their late responses', async () => {
    const signals: AbortSignal[] = [];
    const pending: Array<(value: LanSearchResponse) => void> = [];
    const client = makeClient({
      list: async () => ({
        rootId: 'root', id: '', name: 'Docs', path: '/', parentId: null, entries: [entry()],
      }),
      search: (_rootId, _query, _tag, signal) => {
        if (signal) signals.push(signal);
        return new Promise((resolve) => { pending.push(resolve); });
      },
    });
    const { unmount } = await renderPaired(client);
    rtl.fireEvent.change(rtl.screen.getByLabelText('Search files and folders'), { target: { value: 'one' } });
    await rtl.waitFor(() => assert.equal(signals.length, 1), { timeout: 1500 });
    rtl.fireEvent.change(rtl.screen.getByLabelText('Search files and folders'), { target: { value: 'two' } });
    await rtl.waitFor(() => assert.equal(signals.length, 2), { timeout: 1500 });
    assert.equal(signals[0].aborted, true);
    assert.equal(signals[1].aborted, false);
    pending[0]({ entries: [entry({ id: 'late', name: 'late.txt' })], indexUnavailable: false });
    await rtl.act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    assert.equal(rtl.screen.queryByRole('button', { name: 'Open: late.txt' }), null);
    unmount();
    assert.equal(signals[1].aborted, true);
  });

  it('times out stalled requests instead of leaving the pane loading', async () => {
    const client = makeClient({
      list: (_rootId, _id, signal) => new Promise<LanListResponse>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    });
    rtl.render(<App client={client} initialLanguage="en" requestTimeoutMs={25} />);
    rtl.fireEvent.change(await rtl.screen.findByLabelText('Pairing token'), { target: { value: 'secret' } });
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Connect' }));
    await rtl.screen.findByText('Could not load this content. Check the connection and try again.', undefined, { timeout: 3000 });
    assert.equal(document.querySelector('.results-area')?.getAttribute('aria-busy'), 'false');
  });

  it('localizes the document language and title and follows language changes', async () => {
    const client = makeClient();
    await renderPaired(client);
    assert.equal(document.documentElement.lang, 'en');
    assert.equal(document.title, 'WhaleTag — Read-only');
    await rtl.act(async () => {
      rtl.fireEvent.mouseDown(rtl.screen.getByRole('combobox', { name: 'Language' }));
    });
    const korean = await rtl.screen.findByRole('option', { name: '한국어' });
    await rtl.act(async () => {
      rtl.fireEvent.click(korean);
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    assert.equal(document.documentElement.lang, 'ko');
    assert.equal(document.title, 'WhaleTag — 읽기 전용');
  });

  it('keeps tag chips and offers a retry when the tags endpoint fails', async () => {
    let fail = false;
    let tagCalls = 0;
    const client = makeClient({
      list: async () => ({
        rootId: 'root', id: '', name: 'Docs', path: '/', parentId: null, entries: [entry()],
      }),
      tags: async () => {
        tagCalls += 1;
        if (fail) throw new LanApiError(500);
        return { tags: ['work'], indexUnavailable: false };
      },
    });
    await renderPaired(client);
    await rtl.screen.findByRole('button', { name: 'work' });
    fail = true;
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Refresh' }));
    await rtl.screen.findByText('Tags could not be loaded. Files are still listed; try again.');
    assert.ok(rtl.screen.getByRole('button', { name: 'work' }), 'chips must survive a failed refresh');
    assert.equal(tagCalls, 2);
    fail = false;
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Retry' }));
    await rtl.waitFor(() => assert.equal(
      rtl.screen.queryByText('Tags could not be loaded. Files are still listed; try again.'),
      null,
    ));
    assert.equal(tagCalls, 3);
  });

  it('reloads roots from the refresh button when no location is shared', async () => {
    let rootsCalls = 0;
    const client = makeClient({
      roots: async () => {
        rootsCalls += 1;
        return { roots: rootsCalls === 1 ? [] : [docs] };
      },
      list: async () => ({
        rootId: 'root', id: '', name: 'Docs', path: '/', parentId: null, entries: [],
      }),
    });
    await renderPaired(client);
    await rtl.screen.findByText('No shared locations are available.');
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Refresh' }));
    await rtl.screen.findByText('This folder is empty.');
    assert.equal(rootsCalls, 2);
  });

  it('does not claim "no results" when the search index is unavailable', async () => {
    let searchCalls = 0;
    const client = makeClient({
      list: async () => ({
        rootId: 'root', id: '', name: 'Docs', path: '/', parentId: null, entries: [entry()],
      }),
      tags: async () => ({ tags: [], indexUnavailable: true }),
      search: async () => {
        searchCalls += 1;
        return { entries: [], indexUnavailable: true };
      },
    });
    await renderPaired(client);
    // The notice appears once the tags request settles, which is a separate
    // effect from the location list the pairing helper waits for.
    await rtl.screen.findByText('Search and tags are unavailable until the desktop app builds its index.');
    rtl.fireEvent.change(rtl.screen.getByLabelText('Search files and folders'), { target: { value: 'report' } });
    await rtl.waitFor(() => assert.equal(searchCalls, 1), { timeout: 1500 });
    assert.equal(rtl.screen.queryByText('No matching files or tags.'), null);
    assert.equal(rtl.screen.queryByText('This folder is empty.'), null);
  });

  it('marks the results region busy and announces empty states', async () => {
    let resolveList: ((value: LanListResponse) => void) | undefined;
    const client = makeClient({
      list: () => new Promise<LanListResponse>((resolve) => { resolveList = resolve; }),
    });
    await renderPaired(client);
    await rtl.waitFor(() => assert.equal(
      document.querySelector('.results-area')?.getAttribute('aria-busy'),
      'true',
    ));
    assert.ok(rtl.screen.getAllByRole('status').some((node) => node.textContent?.includes('Loading…')));
    await rtl.act(async () => {
      resolveList?.({ rootId: 'root', id: '', name: 'Docs', path: '/', parentId: null, entries: [] });
    });
    await rtl.screen.findByText('This folder is empty.');
    assert.equal(document.querySelector('.results-area')?.getAttribute('aria-busy'), 'false');
    assert.ok(rtl.screen.getAllByRole('status').some((node) => node.textContent?.includes('This folder is empty.')));
  });

  it('maps pairing failures to localized copy without exposing raw errors', async () => {
    const client = makeClient({ pair: async () => { throw new LanApiError(429, 'Request failed (429)'); } });
    rtl.render(<App client={client} initialLanguage="zh" />);
    rtl.fireEvent.change(await rtl.screen.findByLabelText('配对令牌'), { target: { value: 'bad' } });
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: '连接' }));
    await rtl.screen.findByText('配对尝试过于频繁，请稍等一分钟再试。');
    assert.equal(rtl.screen.queryByText('Request failed (429)'), null);
  });

  it('uses a generic connection message for network pairing failures', async () => {
    const client = makeClient({ pair: async () => { throw new TypeError('Failed to fetch'); } });
    rtl.render(<App client={client} initialLanguage="en" />);
    rtl.fireEvent.change(await rtl.screen.findByLabelText('Pairing token'), { target: { value: 'bad' } });
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Connect' }));
    await rtl.screen.findByText('Could not reach WhaleTag. Check the Wi-Fi connection and try again.');
    assert.equal(rtl.screen.queryByText('Failed to fetch'), null);
  });
});
