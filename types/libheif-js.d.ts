// The JavaScript wrapper libheif-js puts over its Emscripten build. The package
// ships a declaration for the raw Emscripten module only, not for this.
declare module "libheif-js/wasm-bundle" {
  interface HeifImageData {
    data: Uint8ClampedArray;
    width: number;
    height: number;
  }

  interface HeifImage {
    get_width(): number;
    get_height(): number;
    /** Decode to interleaved RGBA into `imageData`; the callback gets null on failure. */
    display(
      imageData: HeifImageData,
      callback: (result: HeifImageData | null) => void,
    ): void;
    free(): void;
  }

  class HeifDecoder {
    /** The parse context decode() allocates. Nothing on this class frees it. */
    decoder: number | null;
    /** Parse the file and return its top-level images, without decoding pixels. */
    decode(buffer: Uint8Array): HeifImage[];
  }

  const libheif: {
    HeifDecoder: typeof HeifDecoder;
    heif_context_free(context: number): void;
  };

  export default libheif;
}
