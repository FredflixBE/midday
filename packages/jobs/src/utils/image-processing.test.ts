import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { JobLogger } from "@jobs/processors/types";
import sharp from "sharp";
import {
  ImageTooLargeError,
  isNonRetryableError,
} from "./error-classification";
import { convertHeicToJpeg } from "./image-processing";

/**
 * A 320x240 gradient, encoded by macOS the way an iPhone encodes a photo:
 * HEVC inside HEIF. sharp's prebuilt libvips has no HEVC decoder on any
 * platform, so this takes the same fallback path a real photo does.
 */
const heicPhoto = readFileSync(
  new URL("./__fixtures__/synthetic-320x240.heic", import.meta.url),
);

const silent: JobLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

async function pixelAt(jpeg: Buffer, x: number, y: number) {
  const { data, info } = await sharp(jpeg)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return [data[offset], data[offset + 1], data[offset + 2]];
}

describe("convertHeicToJpeg", () => {
  test("converts an HEVC photo that sharp cannot decode", async () => {
    const result = await convertHeicToJpeg(toArrayBuffer(heicPhoto), silent);
    const metadata = await sharp(result.buffer).metadata();

    expect(result.mimetype).toBe("image/jpeg");
    expect(metadata.format).toBe("jpeg");
    expect(metadata.width).toBe(320);
    expect(metadata.height).toBe(240);
  });

  test("keeps the picture, not just its size", async () => {
    const { buffer } = await convertHeicToJpeg(
      toArrayBuffer(heicPhoto),
      silent,
    );

    // The fixture runs red left to right and green top to bottom, over a
    // constant blue. A channel swap or a stride error lands far outside this.
    const [r1, g1, b1] = await pixelAt(buffer, 2, 2);
    const [r2, g2, b2] = await pixelAt(buffer, 317, 237);

    expect(r1).toBeLessThan(30);
    expect(g1).toBeLessThan(30);
    expect(r2).toBeGreaterThan(225);
    expect(g2).toBeGreaterThan(225);
    expect(Math.abs((b1 ?? 0) - 128)).toBeLessThan(20);
    expect(Math.abs((b2 ?? 0) - 128)).toBeLessThan(20);
  });

  test("scales down to the max dimension", async () => {
    const { buffer } = await convertHeicToJpeg(
      toArrayBuffer(heicPhoto),
      silent,
      { maxSize: 160 },
    );
    const metadata = await sharp(buffer).metadata();

    expect(metadata.width).toBe(160);
    expect(metadata.height).toBe(120);
  });

  test("refuses a photo over the pixel ceiling, whatever its file size", async () => {
    // 1.7 KB on disk and 0.08 megapixels decoded: the ceiling is on pixels,
    // because that is what the decode costs.
    const attempt = convertHeicToJpeg(toArrayBuffer(heicPhoto), silent, {
      maxMegapixels: 0.05,
    });

    await expect(attempt).rejects.toBeInstanceOf(ImageTooLargeError);

    const error = await attempt.catch((e: unknown) => e);
    expect(isNonRetryableError(error)).toBe(true);
    expect((error as ImageTooLargeError).megapixels).toBeCloseTo(0.0768, 3);
  });

  test("still converts a JPEG that arrived labelled as HEIC", async () => {
    const jpeg = await sharp({
      create: {
        width: 100,
        height: 50,
        channels: 3,
        background: { r: 10, g: 20, b: 30 },
      },
    })
      .jpeg()
      .toBuffer();

    const result = await convertHeicToJpeg(toArrayBuffer(jpeg), silent);
    const metadata = await sharp(result.buffer).metadata();

    expect(metadata.width).toBe(100);
    expect(metadata.height).toBe(50);
  });
});
