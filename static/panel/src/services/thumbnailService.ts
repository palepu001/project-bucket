import * as pdfjsLib from 'pdfjs-dist';
import { AttachmentThumbnailStatus, classifyExtension, extensionOf } from '../types';

// Served as a same-origin static file by build.js (not bundled). Forge Custom
// UI's CSP only permits blob: in script-src when the manifest declares it
// (permissions.content.scripts), and a plain relative URL sidesteps the
// question entirely — so this stays the primary path even now that blob: is
// declared as a fallback.
pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs';

// Long-edge size of the generated rendition. ONE image serves both the gallery
// grid (downscaled by CSS) and the preview modal, so this is sized for the
// modal; generating a second, smaller grid-specific copy would double the
// stored objects and the upload batch for no visible gain.
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.82;

export interface ThumbnailResult {
  blob: Blob | null;
  status: AttachmentThumbnailStatus;
}

const UNSUPPORTED: ThumbnailResult = { blob: null, status: 'UNSUPPORTED' };
const FAILED: ThumbnailResult = { blob: null, status: 'FAILED' };

// Only these two categories can be rendered client-side without depending on
// anything the storage location provides:
//   IMAGES — createImageBitmap reads a Blob directly, no URL of any scheme
//   PDF    — pdf.js accepts raw bytes, so no blob: document URL either
// Video is deliberately excluded: a poster frame needs <video src>, and both
// available routes are dead ends — a local blob: URL needs blob: in media-src
// (which permissions.content cannot declare, it accepts styles and scripts
// only), and a remote URL taints the canvas without CORS headers the storage
// contract does not promise. Office needs LibreOffice. Both keep their icons.
export function canRenderThumbnail(filename: string, mimeType?: string): boolean {
  const category = classifyExtension(extensionOf(filename));
  if (category === 'PDF') return true;
  if (category !== 'IMAGES') return false;
  // SVG is classified as an image but is markup, not raster bytes.
  // createImageBitmap on untrusted SVG is a needless attack surface, and the
  // grid renders SVGs fine from the original anyway.
  return mimeType !== 'image/svg+xml' && extensionOf(filename) !== 'svg';
}

function scaledSize(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= MAX_EDGE) return { width, height };
  const ratio = MAX_EDGE / longest;
  return { width: Math.round(width * ratio), height: Math.round(height * ratio) };
}

function toJpegBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
}

async function renderImage(source: Blob): Promise<Blob | null> {
  const bitmap = await createImageBitmap(source);
  try {
    const { width, height } = scaledSize(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    return await toJpegBlob(canvas);
  } finally {
    // Frees the decoded bitmap immediately rather than waiting for GC — a
    // multi-file upload would otherwise hold every full-resolution decode in
    // memory at once.
    bitmap.close();
  }
}

async function renderPdfFirstPage(source: Blob): Promise<Blob | null> {
  const bytes = new Uint8Array(await source.arrayBuffer());
  const loadingTask = pdfjsLib.getDocument({ data: bytes });
  try {
    const doc = await loadingTask.promise;
    const page = await doc.getPage(1);
    const unscaled = page.getViewport({ scale: 1 });
    const { width } = scaledSize(unscaled.width, unscaled.height);
    const viewport = page.getViewport({ scale: width / unscaled.width });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    // White base: PDF pages are transparent where unpainted, which would
    // otherwise flatten to black in a JPEG.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvas, canvasContext: context, viewport }).promise;
    return await toJpegBlob(canvas);
  } finally {
    // destroy() on the loading task, not cleanup() on the proxy — the latter
    // frees caches but leaves the worker running.
    await loadingTask.destroy().catch(() => undefined);
  }
}

/**
 * Render a preview image for one file, entirely in the browser.
 *
 * Never throws: a thumbnail is an enhancement, and a corrupt or oversized file
 * must not be able to fail the upload that carries it. Callers persist the
 * returned status verbatim — recording UNSUPPORTED/FAILED is what stops the
 * gallery retrying the same file on every render.
 */
export async function generateThumbnail(source: Blob, filename: string, mimeType?: string): Promise<ThumbnailResult> {
  if (!canRenderThumbnail(filename, mimeType)) return UNSUPPORTED;
  try {
    const category = classifyExtension(extensionOf(filename));
    const blob = category === 'PDF' ? await renderPdfFirstPage(source) : await renderImage(source);
    return blob ? { blob, status: 'READY' } : FAILED;
  } catch (error) {
    console.warn(`[ProjectBucket] Thumbnail generation failed for "${filename}":`, error);
    return FAILED;
  }
}

// Filename given to the generated object. It never reaches the user — the
// gallery always displays the attachment's own filename — but it does pass
// through the backend's stateless validators, which key off the extension.
export function thumbnailFilenameFor(filename: string): string {
  return `${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}.thumb.jpg`;
}
