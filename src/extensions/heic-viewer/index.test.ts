import globalJsdom from 'global-jsdom';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { HostMessage } from '../../shared/extension-types';
import type {} from '../shared/whale-ext';

/**
 * Lifetime of the images libheif hands out for one decode. They live in the
 * wasm heap until `free()` is called, so every image must be freed whichever
 * way a load ends — a HEIC usually carries a thumbnail overlay next to the
 * primary picture, and only the primary one is shown.
 */

const require_ = createRequire(__filename);

interface DecodedImage {
  freed: boolean;
  get_width(): number;
  get_height(): number;
  display(target: unknown, cb: (ok: unknown) => void): void;
  free(): void;
}

const listeners = new Set<(msg: HostMessage) => void>();
const posted: { type: string; requestId?: string }[] = [];
/** The images the fake decoder returned for the latest decode. */
let decoded: DecodedImage[] = [];
/** How many images the next decode yields. */
let imageCount = 3;
/** What the fake `display()` callback reports. */
let displayOk = true;
let jsdomCleanup: (() => void) | null = null;
let injectedId = '';

function inject(spec: string, exports: unknown): void {
  injectedId = require_.resolve(spec);
  const previous = require_.cache[injectedId];
  require_.cache[injectedId] = {
    id: injectedId,
    filename: injectedId,
    loaded: true,
    exports,
    children: [],
    paths: [],
  } as unknown as NodeJS.Module;
  after(() => {
    if (previous) require_.cache[injectedId] = previous;
    else delete require_.cache[injectedId];
  });
}

function emitHost(msg: HostMessage): void {
  listeners.forEach((listener) => listener(msg));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Answers the viewer's wasm request the way the host does. */
async function deliverWasm(): Promise<void> {
  await sleep(10);
  const request = posted.filter((msg) => msg.type === 'requestHeicWasm').at(-1);
  assert.ok(request?.requestId, 'the viewer must ask the host for the wasm');
  emitHost({ type: 'heicWasm', requestId: request.requestId, data: new ArrayBuffer(8) });
}

function openFile(path: string): void {
  emitHost({
    type: 'fileContent',
    path,
    content: globalThis.btoa('ftypheic'),
    encoding: 'base64',
    readOnly: true,
  });
}

async function settle(): Promise<void> {
  await sleep(40);
}

before(() => {
  jsdomCleanup = globalJsdom() as unknown as () => void;
  const html = readFileSync(join(__dirname, 'index.html'), 'utf8');
  document.body.innerHTML = html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? '';
  Object.defineProperty(window, 'whaleExt', {
    configurable: true,
    value: {
      locale: 'en',
      t: (catalog: { en: unknown }) => catalog.en,
      postMessage(msg: { type: string; requestId?: string }) {
        posted.push(msg);
      },
      onMessage(listener: (msg: HostMessage) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onLocale() {
        return () => {};
      },
    },
  });
  // jsdom has neither a canvas nor object URLs.
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({
      createImageData(width: number, height: number) {
        return { width, height, data: new Uint8ClampedArray(width * height * 4) };
      },
      putImageData() {},
    }),
  });
  Object.defineProperty(window.HTMLCanvasElement.prototype, 'toBlob', {
    configurable: true,
    value: (cb: (blob: Blob | null) => void) => {
      cb(new Blob(['jpeg']));
    },
  });

  inject('libheif-js/libheif-wasm/libheif.js', {
    __esModule: true,
    default: () => ({
      HeifDecoder: class {
        decode(): DecodedImage[] {
          decoded = Array.from({ length: imageCount }, () => ({
            // Annotated on purpose: a bare `false` would narrow `this.freed`
            // inside `free()` to the literal type.
            freed: false as boolean,
            get_width: () => 4,
            get_height: () => 3,
            display: (_target, cb) => cb(displayOk),
            free() {
              this.freed = true;
            },
          }));
          return decoded;
        }
      },
    }),
  });
  require_('./index');
});

after(() => {
  listeners.clear();
  jsdomCleanup?.();
});

describe('heic-viewer decoded-image lifetime', () => {
  it('frees every decoded image once the picture is on screen, not only the primary one', async () => {
    imageCount = 3;
    displayOk = true;
    openFile('/tmp/photo.heic');
    await deliverWasm();
    await settle();

    assert.equal(decoded.length, 3);
    assert.deepEqual(
      decoded.map((image) => image.freed),
      [true, true, true]
    );
    const image = document.getElementById('image') as HTMLImageElement;
    assert.match(image.getAttribute('src') ?? '', /^blob:/, 'the picture was shown');
    assert.equal(
      (document.getElementById('error-message') as HTMLParagraphElement).textContent,
      '',
      'no error'
    );
  });

  it('frees them when the primary image fails to decode', async () => {
    imageCount = 2;
    displayOk = false;
    openFile('/tmp/broken.heic');
    await deliverWasm();
    await settle();

    assert.deepEqual(
      decoded.map((image) => image.freed),
      [true, true]
    );
    assert.match(
      (document.getElementById('error-message') as HTMLParagraphElement).textContent,
      /libheif decode returned no data/
    );
  });

  it('reports a file without a decodable image', async () => {
    imageCount = 0;
    displayOk = true;
    openFile('/tmp/empty.heic');
    await deliverWasm();
    await settle();

    assert.deepEqual(decoded, []);
    assert.match(
      (document.getElementById('error-message') as HTMLParagraphElement).textContent,
      /no decodable image found in this file/
    );
  });
});
