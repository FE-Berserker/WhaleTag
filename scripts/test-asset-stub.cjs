/**
 * Loaded via `--require` BEFORE any test file, so its require-extensions stubs
 * are in place before the test files' top-level imports run.
 *
 * Webpack resolves `import x from '*.svg'` (and png/jpg/...) through asset
 * loaders and hands the import a URL string. ts-node has no such loader and
 * would try to parse the asset bytes as JavaScript (e.g. an SVG starts with
 * `<svg ...>` → `SyntaxError: Unexpected token '<'`). Several renderer
 * components import brand/format icons this way (e.g. FileTypeIcon pulls in
 * excalidraw-icon.svg), and component tests reach them transitively, so we stub
 * every asset extension to an empty string URL — matching webpack's "URL" shape.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const stub = (module) => {
  module._compile('module.exports = ""', 'asset-stub');
};
for (const ext of [
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.eot',
  '.ttf',
  '.woff',
  '.woff2',
  '.css', // H.26: Leaflet / MarkerCluster CSS imports for MapiqueView tests
]) {
  require.extensions[ext] = stub;
}
