import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { JobLogger } from "@jobs/processors/types";
import sharp from "sharp";
import {
  ImageTooLargeError,
  isNonRetryableError,
} from "./error-classification";
import { convertHeicToJpeg, HEIC_MEGAPIXEL_CEILING } from "./image-processing";

/**
 * A 320x240 gradient, encoded by macOS the way an iPhone encodes a photo:
 * HEVC inside HEIF. sharp's prebuilt libvips has no HEVC decoder on any
 * platform, so this takes the same fallback path a real photo does.
 */
const heicPhoto = readFileSync(
  new URL("./__fixtures__/synthetic-320x240.heic", import.meta.url),
);

/**
 * Flat colour, so HEVC compresses each to under 20 KB — but they decode to 16
 * and 36 megapixels. What a decode costs is set by the pixels, not the file.
 */
const sixteenMegapixels = readFileSync(
  new URL("./__fixtures__/flat-4600x3500.heic", import.meta.url),
);
const thirtySixMegapixels = readFileSync(
  new URL("./__fixtures__/flat-6000x6000.heic", import.meta.url),
);

const onSmall2x = { machine: "small-2x" } as const;

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
    const result = await convertHeicToJpeg(
      toArrayBuffer(heicPhoto),
      silent,
      onSmall2x,
    );
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
      onSmall2x,
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
      { ...onSmall2x, maxSize: 160 },
    );
    const metadata = await sharp(buffer).metadata();

    expect(metadata.width).toBe(160);
    expect(metadata.height).toBe(120);
  });

  test("refuses a photo with more pixels than the machine can hold, whatever its file size", async () => {
    const attempt = convertHeicToJpeg(
      toArrayBuffer(thirtySixMegapixels),
      silent,
      onSmall2x,
    );

    await expect(attempt).rejects.toBeInstanceOf(ImageTooLargeError);

    const error = (await attempt.catch(
      (e: unknown) => e,
    )) as ImageTooLargeError;
    expect(isNonRetryableError(error)).toBe(true);
    expect(error.megapixels).toBe(36);
    expect(error.maxMegapixels).toBe(HEIC_MEGAPIXEL_CEILING["small-2x"]);
    expect(error.message).toContain("36.0 megapixels");
  });

  test("gives a small-1x less room than a small-2x", async () => {
    const small1x = convertHeicToJpeg(
      toArrayBuffer(sixteenMegapixels),
      silent,
      { machine: "small-1x" },
    );
    await expect(small1x).rejects.toBeInstanceOf(ImageTooLargeError);

    const small2x = await convertHeicToJpeg(
      toArrayBuffer(sixteenMegapixels),
      silent,
      onSmall2x,
    );
    const metadata = await sharp(small2x.buffer).metadata();
    expect(metadata.width).toBe(2048);
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

    const result = await convertHeicToJpeg(
      toArrayBuffer(jpeg),
      silent,
      onSmall2x,
    );
    const metadata = await sharp(result.buffer).metadata();

    expect(metadata.width).toBe(100);
    expect(metadata.height).toBe(50);
  });
});
