/**
 * pdfjs 6 decides whether to use its Node factories with this Electron check:
 * `!(process.versions.electron && process.type && process.type !== 'browser')`.
 *
 * A utilityProcess has Node APIs but reports `process.type === 'utility'`, so
 * pdfjs otherwise selects DOMCanvasFactory / DOMBinaryDataFactory and reads
 * `document.baseURI` while constructing the loading task. There is no public
 * `nodeMode` option. Normalize the type only while the dedicated utility child
 * performs its first lazy require, so pdfjs takes its supported Node path
 * (Node factories, fs-backed resources, fake worker, canvas polyfills).
 *
 * Never call this from a renderer. The original property descriptor is restored
 * immediately after the module loads (or throws), so later dependencies still
 * see the real Electron process type.
 */
export function withPdfjsNodeRuntime<T>(load: () => T): T {
  if (!process.versions.electron || process.type !== 'utility') return load();
  const descriptor = Object.getOwnPropertyDescriptor(process, 'type');
  if (!descriptor) return load();
  Object.defineProperty(process, 'type', { ...descriptor, value: 'browser' });
  try {
    return load();
  } finally {
    Object.defineProperty(process, 'type', descriptor);
  }
}
