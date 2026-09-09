import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The fonts the OG images render with.
 *
 * These used to be fetched from cdn.midday.ai on every render, which made a
 * self-hosted instance depend on Midday's CDN and threw when it was
 * unreachable. They are vendored under src/assets/fonts instead — see
 * next.config.ts, which traces them into the standalone build.
 */
const FONT_DIR = join(process.cwd(), "src", "assets", "fonts");

let sans: Promise<Buffer> | null = null;
let serif: Promise<Buffer> | null = null;

/** Hedvig Letters Sans, the face the dashboard itself uses. */
export function getOgSansFont(): Promise<Buffer> {
  sans ??= readFile(join(FONT_DIR, "HedvigLettersSans-Regular.ttf"));
  return sans;
}

/** Hedvig Letters Serif, used for headings in the report OG image. */
export function getOgSerifFont(): Promise<Buffer> {
  serif ??= readFile(join(FONT_DIR, "HedvigLettersSerif-Regular.ttf"));
  return serif;
}
