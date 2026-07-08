// Ambient types for `occt-import-js` (ships no .d.ts and has no @types package).
// Shapes taken from the official README: the result is a three.js-compatible
// scene graph with per-mesh position/normal/index arrays.
declare module 'occt-import-js' {
  export interface OcctMeshAttribute {
    array: number[];
  }
  export interface OcctMesh {
    name?: string;
    /** RGB in 0-1 floats, optional. */
    color?: [number, number, number];
    brep_faces?: Array<{
      first: number;
      last: number;
      color: [number, number, number] | null;
    }>;
    attributes: {
      position: OcctMeshAttribute;
      normal?: OcctMeshAttribute;
    };
    index: { array: number[] };
  }
  export interface OcctNode {
    name?: string;
    /** Indices into the result's top-level meshes[] array. */
    meshes?: number[];
    children?: OcctNode[];
  }
  export interface OcctResult {
    success: boolean;
    root: OcctNode;
    meshes: OcctMesh[];
  }
  export interface OcctParams {
    linearUnit?: 'millimeter' | 'centimeter' | 'meter' | 'inch' | 'foot';
    linearDeflectionType?: 'bounding_box_ratio' | 'absolute_value';
    linearDeflection?: number;
    angularDeflection?: number;
  }
  export interface OcctModule {
    ReadStepFile(content: Uint8Array, params: OcctParams | null): OcctResult;
    ReadIgesFile(content: Uint8Array, params: OcctParams | null): OcctResult;
    ReadBrepFile(content: Uint8Array, params: OcctParams | null): OcctResult;
  }
  export interface OcctFactoryOptions {
    /** Emscripten locateFile: redirect where the `.wasm` is fetched from. */
    locateFile?: (name: string) => string;
    /** Pre-loaded wasm bytes — when set, emscripten skips its fetch/locateFile
     *  and compiles this directly. cad-viewer uses this (the wasm bytes come
     *  from the host via the requestCadWasm bridge, since fetch on
     *  whale-extension:// is unreliable). */
    wasmBinary?: ArrayBuffer;
  }
  function occtimportjs(options?: OcctFactoryOptions): Promise<OcctModule>;
  export default occtimportjs;
}
