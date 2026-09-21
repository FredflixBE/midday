/**
 * Drawing a mermaid diagram, and turning what it drew into a picture
 * (FF-1643).
 *
 * Mermaid is a large dependency and is never part of the page: it is
 * imported the first time a diagram is actually being written, so opening a
 * quote that holds ten of them loads none of it.
 */

/** What a diagram is drawn at, against the size mermaid gives it. */
const SCALE = 2;

let loading: Promise<typeof import("mermaid").default> | null = null;

function mermaidModule() {
  // Held so that typing in the dialog does not fetch it again on every
  // keystroke; the import itself is only reached once a diagram is open. A
  // failed one is not held, or a network blip at the wrong moment would
  // leave the dialog unable to draw anything for as long as the page lives.
  loading ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      // Labels as real SVG text, never `foreignObject`. A canvas cannot draw
      // foreign content, so HTML labels would come out of the PNG blank —
      // and the PNG is the only thing any renderer ever sees.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      theme: "neutral",
      fontFamily: "inherit",
    });
    return mermaid;
  });
  return loading.catch((error: unknown) => {
    loading = null;
    throw error;
  });
}

/** Mermaid's own reading of the source, as the message it would show. */
export async function drawDiagram(source: string, id: string): Promise<string> {
  const mermaid = await mermaidModule();
  const { svg } = await mermaid.render(id, source);
  return svg;
}

/** The size the drawing wants to be, from its own attributes. */
function sizeOf(svg: string): { width: number; height: number } {
  const viewBox = svg.match(/viewBox="([\d.\-\s]+)"/)?.[1]?.split(/\s+/);
  if (viewBox?.length === 4) {
    const width = Number(viewBox[2]);
    const height = Number(viewBox[3]);
    if (width > 0 && height > 0) return { width, height };
  }
  // Mermaid writes a percentage width on some diagrams, which tells a canvas
  // nothing; a square is better than a drawing with no size at all.
  return { width: 800, height: 800 };
}

/**
 * The drawing as PNG bytes.
 *
 * A quote is drawn four ways and only one of them is a browser — react-pdf
 * draws a slice of SVG and no foreign content at all — so the diagram is
 * turned into a picture once, here, where a browser is doing the drawing
 * (FF-1643). What every renderer then gets is a picture, which they all
 * already know how to draw.
 */
export async function diagramToPng(svg: string): Promise<Blob> {
  const { width, height } = sizeOf(svg);
  // Sized on the way in: the canvas draws the SVG at whatever size the SVG
  // asks for, and mermaid writes `width="100%"` with the real size in a
  // `max-width` style, which a canvas reads as one pixel.
  //
  // The sizes it already carries have to come off first. A data URL is
  // parsed as XML, where a repeated attribute is not last-one-wins but a
  // fatal error — a second `width` would make the whole picture fail to
  // load, and the only sign of it is a diagram that will not save.
  const sized = svg.replace(/<svg([^>]*)>/, (_, attributes: string) => {
    const kept = attributes
      .replace(/\s(?:width|height)="[^"]*"/g, "")
      .replace(/\s*max-width:\s*[^;"]*;?/g, "");
    return `<svg${kept} width="${width}" height="${height}">`;
  });

  const image = new Image();
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("The diagram could not be drawn."));
  });
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`;
  await loaded;

  const canvas = document.createElement("canvas");
  canvas.width = width * SCALE;
  canvas.height = height * SCALE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The diagram could not be drawn.");
  // On white, not on nothing: a PNG with a see-through background reads as
  // grey boxes on a printed page.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("The diagram could not be drawn."));
    }, "image/png");
  });
}
