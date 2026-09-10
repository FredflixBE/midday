import type { JobLogger } from "@jobs/processors/types";
import { ImageTooLargeError } from "@jobs/utils/error-classification";
import { IMAGE_SIZES } from "@jobs/utils/timeout";
import sharp from "sharp";

// Configure sharp for memory efficiency
// Limit concurrent operations and cache size to prevent OOM
sharp.cache({ memory: 256, files: 20, items: 100 }); // 256MB cache limit
sharp.concurrency(2); // Limit internal parallelism per sharp instance

/**
 * The most pixels a HEIC may decode to on the machines that convert them.
 *
 * Not a file size: what a decode costs is set by the pixels, and the file says
 * little about them — a 0.9 MB and a 1.6 MB iPhone photo cost the same, and a
 * 2.5 MB 48-megapixel one costs three times as much. Measured through the
 * conversion below, resident memory peaks about 64 MB plus 13 MB per
 * megapixel above where it started: 223 MB at 12 MP, 361 MB at 24.5 MP,
 * 705 MB at 48.8 MP.
 *
 * Almost none of that is V8 heap — the WebAssembly memory, the pixel buffer
 * and sharp are all outside it, and the heap grows by 6 MB at any size — so
 * the limit that binds is the machine's whole memory, not the heap ceiling
 * Trigger derives from it. Calibrated for small-2x (1 GiB) above a worker that
 * rests at about 210 MB with the task bundle loaded: 32 MP peaks near 700 MB
 * and leaves room for what a warm worker has kept, and the 48 MP an iPhone Pro
 * writes in "HEIF Max" does not fit, so it is refused rather than killed.
 *
 * Every task that calls convertHeicToJpeg runs on small-2x for this reason.
 * A task on a smaller machine needs its own ceiling, or its own machine.
 */
export const MAX_HEIC_MEGAPIXELS = 32;

export interface HeicConversionResult {
  buffer: Buffer;
  mimetype: "image/jpeg";
}

export interface ImageProcessingOptions {
  maxSize?: number;
}

export interface HeicConversionOptions extends ImageProcessingOptions {
  maxMegapixels?: number;
}

export interface ResizeResult {
  buffer: Buffer;
  mimetype: string;
}

/**
 * Supported image mimetypes for resizing
 */
const RESIZABLE_MIMETYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/tiff",
]);

/**
 * Resize an image to fit within maxSize dimensions.
 *
 * - Preserves aspect ratio (resizes longest side to maxSize)
 * - Skips resize if image is already small enough
 * - Returns original buffer for unsupported mimetypes
 *
 * @param inputBuffer - Raw image buffer (ArrayBuffer from file download)
 * @param mimetype - Image mimetype (e.g., "image/jpeg")
 * @param logger - Logger instance for status messages
 * @param options - Optional configuration (maxSize defaults to IMAGE_SIZES.MAX_DIMENSION)
 * @returns Resized buffer and mimetype
 */
export async function resizeImage(
  inputBuffer: ArrayBuffer,
  mimetype: string,
  logger: JobLogger,
  options?: ImageProcessingOptions,
): Promise<ResizeResult> {
  const maxSize = options?.maxSize ?? IMAGE_SIZES.MAX_DIMENSION;

  // Validate input buffer
  if (!inputBuffer || inputBuffer.byteLength === 0) {
    throw new Error("Input buffer is empty");
  }

  // Skip non-image or unsupported formats
  if (!RESIZABLE_MIMETYPES.has(mimetype.toLowerCase())) {
    logger.info("Skipping resize for unsupported mimetype", { mimetype });
    return { buffer: Buffer.from(inputBuffer), mimetype };
  }

  try {
    const image = sharp(Buffer.from(inputBuffer));
    const metadata = await image.metadata();

    // Skip if already within size limits
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width <= maxSize && height <= maxSize) {
      logger.info("Image already within size limits, skipping resize", {
        width,
        height,
        maxSize,
      });
      return { buffer: Buffer.from(inputBuffer), mimetype };
    }

    // Resize to fit within maxSize (preserves aspect ratio)
    const buffer = await image
      .rotate() // Auto-rotate based on EXIF
      .resize({
        width: maxSize,
        height: maxSize,
        fit: "inside", // Maintain aspect ratio, fit within bounds
        withoutEnlargement: true, // Don't upscale small images
      })
      .toBuffer();

    logger.info("Image resized successfully", {
      originalWidth: width,
      originalHeight: height,
      maxSize,
    });

    return { buffer, mimetype };
  } catch (error) {
    logger.warn("Failed to resize image, returning original", {
      error: error instanceof Error ? error.message : "Unknown error",
      mimetype,
    });
    // Return original on error - graceful degradation
    return { buffer: Buffer.from(inputBuffer), mimetype };
  }
}

/**
 * Convert HEIC/HEIF image to JPEG.
 *
 * sharp is tried first, for what it can read: a JPEG that arrived named .heic,
 * or a HEIF that is not HEVC inside. An iPhone photo is HEVC, and sharp's
 * prebuilt libvips has no HEVC decoder on any platform we run on — so for a
 * real photo the second path is the normal one, not a fallback.
 *
 * @throws ImageTooLargeError when the image decodes to more than
 *   `maxMegapixels` — decided from the file's header, before any pixel is
 *   decoded
 * @throws Error if neither path can read the file
 */
export async function convertHeicToJpeg(
  inputBuffer: ArrayBuffer,
  logger: JobLogger,
  options?: HeicConversionOptions,
): Promise<HeicConversionResult> {
  const maxSize = options?.maxSize ?? IMAGE_SIZES.MAX_DIMENSION;
  const maxMegapixels = options?.maxMegapixels ?? MAX_HEIC_MEGAPIXELS;

  // Validate input buffer
  if (!inputBuffer || inputBuffer.byteLength === 0) {
    throw new Error("Input buffer is empty");
  }

  let sharpError: unknown;

  try {
    const buffer = await toResizedJpeg(
      sharp(Buffer.from(inputBuffer)),
      maxSize,
    );

    logger.info("HEIC conversion successful with sharp");
    return { buffer, mimetype: "image/jpeg" };
  } catch (error) {
    sharpError = error;
    logger.info("sharp cannot read this HEIC, decoding it with libheif", {
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }

  let decoded: DecodedImage;

  try {
    decoded = await decodeHeic(inputBuffer, maxMegapixels);
  } catch (heicError) {
    if (heicError instanceof ImageTooLargeError) {
      throw heicError;
    }

    // Both methods failed - file is likely corrupted or unsupported
    throw new Error(
      `Failed to convert HEIC image: sharp error: ${sharpError instanceof Error ? sharpError.message : "Unknown"}, libheif error: ${heicError instanceof Error ? heicError.message : "Unknown"}`,
    );
  }

  const { pixels, width, height } = decoded;

  try {
    const buffer = await toResizedJpeg(
      sharp(pixels, { raw: { width, height, channels: 4 } }),
      maxSize,
    );

    logger.info("HEIC conversion successful with libheif", {
      width,
      height,
      megapixels: Number(((width * height) / 1_000_000).toFixed(1)),
    });
    return { buffer, mimetype: "image/jpeg" };
  } catch (finalSharpError) {
    throw new Error(
      `Failed to process decoded HEIC: ${finalSharpError instanceof Error ? finalSharpError.message : "Unknown error"}`,
    );
  }
}

function toResizedJpeg(image: sharp.Sharp, maxSize: number): Promise<Buffer> {
  return image
    .rotate()
    .resize({
      width: maxSize,
      height: maxSize,
      fit: "inside",
      withoutEnlargement: true,
    })
    .toFormat("jpeg")
    .toBuffer();
}

type DecodedImage = { pixels: Buffer; width: number; height: number };

type Libheif = typeof import("libheif-js/wasm-bundle").default;

let libheif: Promise<Libheif> | undefined;

/**
 * Loaded on first use rather than at import: every task bundled beside this
 * file imports it, and only the ones handed a HEIC need a decoder in memory.
 */
function loadLibheif(): Promise<Libheif> {
  libheif ??= import("libheif-js/wasm-bundle").then((module) => module.default);
  return libheif;
}

/**
 * Decode a HEIC to RGBA pixels with libheif's WebAssembly build.
 *
 * This used to be heic-convert, which uses libheif's asm.js build, encodes
 * the full-size image to JPEG in pure JavaScript, and hands that JPEG to sharp
 * to decode all over again: 790 MB at peak for a 24.5 MP photo, where this
 * takes 361 MB in a third of the time.
 *
 * Parsing the file does not decode it, and costs a few megabytes, so the
 * pixel count is known — and a refusal is free — before the expensive part.
 */
async function decodeHeic(
  input: ArrayBuffer,
  maxMegapixels: number,
): Promise<DecodedImage> {
  const { HeifDecoder, heif_context_free } = await loadLibheif();
  const decoder = new HeifDecoder();

  try {
    const images = decoder.decode(new Uint8Array(input));

    try {
      const image = images[0];
      if (!image) {
        throw new Error("No image found in the HEIF container");
      }

      const width = image.get_width();
      const height = image.get_height();
      const megapixels = (width * height) / 1_000_000;

      if (megapixels > maxMegapixels) {
        throw new ImageTooLargeError(megapixels, maxMegapixels);
      }

      const pixels = new Uint8ClampedArray(width * height * 4);

      await new Promise<void>((resolve, reject) => {
        image.display({ data: pixels, width, height }, (result) =>
          result ? resolve() : reject(new Error("libheif could not decode it")),
        );
      });

      return {
        pixels: Buffer.from(
          pixels.buffer,
          pixels.byteOffset,
          pixels.byteLength,
        ),
        width,
        height,
      };
    } finally {
      for (const image of images) {
        image.free();
      }
    }
  } finally {
    // The context holds a copy of the file in WebAssembly memory, which never
    // shrinks. Left alone it leaks one file per conversion into a worker that
    // is kept alive between runs.
    if (decoder.decoder) {
      heif_context_free(decoder.decoder);
    }
  }
}
