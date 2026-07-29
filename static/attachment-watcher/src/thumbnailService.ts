import * as pdfjsLib from 'pdfjs-dist';
import { AttachmentThumbnailStatus, classifyExtension, extensionOf } from './types';
import { extractZipEntry, extractZipEntryByName, readZipEntries, ZipEntry } from './utils/zip';

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
  // null means "not attempted yet" and is what makes the gallery's backfill
  // pick the file up later — used for the categories that can only be rendered
  // once the bytes are AT the storage location (see requiresUrlSource).
  status: AttachmentThumbnailStatus | null;
}

const UNSUPPORTED: ThumbnailResult = { blob: null, status: 'UNSUPPORTED' };
const FAILED: ThumbnailResult = { blob: null, status: 'FAILED' };
const DEFERRED: ThumbnailResult = { blob: null, status: null };

// ---------------------------------------------------------------------------
// What can be rendered, and from what
//
// Project Bucket's rule is that a file in the gallery gets a real preview image
// whenever one can honestly be produced in the browser — not just for the two
// formats that are easiest. Every category below is rendered by the platform
// alone (canvas, WebAudio, DecompressionStream, pdf.js); nothing here needs a
// server-side renderer, which Forge does not offer.
//
//   IMAGES (raster) bytes  createImageBitmap reads a Blob directly
//   IMAGES (svg)    URL    markup, not raster bytes — see renderSvgFromUrl
//   PDF             bytes  pdf.js renders page 1 from raw bytes
//   DOCUMENTS       bytes  the text itself, typeset onto a page-shaped canvas
//   OFFICE          bytes  the embedded preview image inside the container, or
//                          failing that the document's own first lines of text
//   ARCHIVES        bytes  the member listing from the central directory
//   AUDIO           bytes  a waveform decoded with OfflineAudioContext
//   VIDEOS          URL    a frame seeked out of the stored object
//
// The URL-sourced two are the only ones that cannot run at upload time: a
// <video>/<img> element needs a URL, and the only schemes available are blob:
// (which Forge's CSP does not allow for media or images) and the storage
// location's own https URL — which does not exist until the bytes are stored.
// Those files are recorded with a null status at upload, which is precisely
// what makes useThumbnailBackfill render them on the gallery's first view.
// ---------------------------------------------------------------------------

function isSvg(filename: string, mimeType?: string): boolean {
  return mimeType === 'image/svg+xml' || extensionOf(filename) === 'svg';
}

// Office formats that are ZIP containers, and so can be opened here. The
// legacy OLE compound formats (.doc/.ppt/.xls) are a different container
// entirely, with no embedded preview we can reach — they keep their icon rather
// than costing a download that can only end in failure.
const ZIP_BACKED_OFFICE_EXTENSIONS = new Set(['docx', 'pptx', 'xlsx', 'odt', 'ods', 'odp']);

/** Everything this build can ever produce a rendition for, from any source. */
export function canRenderThumbnail(filename: string, mimeType?: string): boolean {
  const extension = extensionOf(filename);
  switch (classifyExtension(extension)) {
    case 'IMAGES':
    case 'PDF':
    case 'DOCUMENTS':
    case 'AUDIO':
    case 'VIDEOS':
      return true;
    case 'OFFICE':
      return ZIP_BACKED_OFFICE_EXTENSIONS.has(extension);
    case 'ARCHIVES':
      // Only ZIP has a listing we can read. .tar/.gz/.rar/.7z/.bz2 each need
      // their own decompressor, which is not worth shipping into an iframe to
      // caption a file — and attempting them would download the whole archive
      // to learn nothing.
      return extension === 'zip';
    default:
      // Extension-less or unknown files still get a text card when the server
      // told us they are text.
      return typeof mimeType === 'string' && mimeType.startsWith('text/');
  }
}

/**
 * True for the categories that can only be rendered from a URL at the storage
 * location, i.e. AFTER the upload — callers holding only local bytes should
 * defer these rather than record a verdict on them.
 */
export function requiresUrlSource(filename: string, mimeType?: string): boolean {
  const category = classifyExtension(extensionOf(filename));
  if (category === 'VIDEOS') return true;
  return category === 'IMAGES' && isSvg(filename, mimeType);
}

// ---------------------------------------------------------------------------
// Canvas plumbing
// ---------------------------------------------------------------------------

function scaledSize(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= MAX_EDGE) return { width, height };
  const ratio = MAX_EDGE / longest;
  return { width: Math.round(width * ratio), height: Math.round(height * ratio) };
}

async function toJpegBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  try {
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
  } finally {
    // Drop the backing store immediately. A 1600px canvas holds ~10 MB of
    // pixels, and the backfill renders file after file — waiting for GC to
    // notice a detached canvas is how a long gallery pass turns into memory
    // pressure, especially in Safari.
    canvas.width = 0;
    canvas.height = 0;
  }
}

// Every raster path funnels through here so scaling, the white base (JPEG has
// no alpha, so anything transparent would otherwise flatten to black) and the
// encode are identical whatever produced the pixels.
async function drawToJpeg(
  intrinsicWidth: number,
  intrinsicHeight: number,
  paint: (context: CanvasRenderingContext2D, width: number, height: number) => void
): Promise<Blob | null> {
  const { width, height } = scaledSize(Math.max(1, intrinsicWidth), Math.max(1, intrinsicHeight));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  paint(context, width, height);
  return toJpegBlob(canvas);
}

async function renderImage(source: Blob): Promise<Blob | null> {
  const bitmap = await createImageBitmap(source);
  try {
    return await drawToJpeg(bitmap.width, bitmap.height, (context, width, height) =>
      context.drawImage(bitmap, 0, 0, width, height)
    );
  } finally {
    // Frees the decoded bitmap immediately rather than waiting for GC — a
    // multi-file upload would otherwise hold every full-resolution decode in
    // memory at once.
    bitmap.close();
  }
}

// Rejects a rendition that carries no information — a flat, single-colour
// image. This is not hypothetical tidiness: the preview image embedded in an
// Office document is only refreshed when the authoring application itself
// saves the file, so decks and documents produced by a script or an export
// tool ship their template's blank white placeholder, and rendering it
// faithfully produces a blank card. A leading PDF page can be empty for the
// same kind of reason. In both cases there is a better source of content to
// fall back to, so detecting "this says nothing" is what makes that possible.
//
// Sampling is done on a 32x32 probe rather than the full-size canvas: it costs
// one small allocation instead of reading back megabytes of pixels, and any
// mark big enough to be worth showing survives the downscale.
const BLANK_LUMINANCE_RANGE = 10;

function looksBlank(image: CanvasImageSource): boolean {
  const probe = document.createElement('canvas');
  probe.width = 32;
  probe.height = 32;
  try {
    const context = probe.getContext('2d', { willReadFrequently: true });
    if (!context) return false;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 32, 32);
    context.drawImage(image, 0, 0, 32, 32);

    const { data } = context.getImageData(0, 0, 32, 32);
    let darkest = 255;
    let lightest = 0;
    for (let index = 0; index < data.length; index += 4) {
      const luminance = (data[index] * 299 + data[index + 1] * 587 + data[index + 2] * 114) / 1000;
      if (luminance < darkest) darkest = luminance;
      if (luminance > lightest) lightest = luminance;
    }
    return lightest - darkest < BLANK_LUMINANCE_RANGE;
  } catch {
    // getImageData throws on a tainted canvas. Unreadable is not blank — say
    // no and let the caller keep whatever it rendered.
    return false;
  } finally {
    probe.width = 0;
    probe.height = 0;
  }
}

// Turns pdf.js text items back into lines. `hasEOL` is the only line-break
// signal the API gives; without honouring it a page collapses into one run-on
// paragraph.
function pdfTextToLines(items: { str?: string; hasEOL?: boolean }[]): string[] {
  const lines: string[] = [];
  let current = '';
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    current += item.str;
    if (item.hasEOL) {
      const trimmed = current.replace(/\s+/g, ' ').trim();
      if (trimmed.length > 0) lines.push(trimmed);
      current = '';
    }
  }
  const trailing = current.replace(/\s+/g, ' ').trim();
  if (trailing.length > 0) lines.push(trailing);
  return lines;
}

// Renders an embedded preview image, or null when it turns out to be blank —
// which is the caller's cue to fall back to the document's own text.
async function renderEmbeddedPreview(embedded: Blob): Promise<Blob | null> {
  const bitmap = await createImageBitmap(embedded);
  try {
    if (looksBlank(bitmap)) return null;
    return await drawToJpeg(bitmap.width, bitmap.height, (context, width, height) =>
      context.drawImage(bitmap, 0, 0, width, height)
    );
  } finally {
    bitmap.close();
  }
}

async function renderPdfFirstPage(source: Blob, filename: string): Promise<Blob | null> {
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

    if (!looksBlank(canvas)) return await toJpegBlob(canvas);

    // An empty-looking first page (a cover sheet pdf.js could not rasterise, a
    // deliberately blank leading page). The page's text is still readable, and
    // a card of it beats a white rectangle.
    canvas.width = 0;
    canvas.height = 0;
    const content = await page.getTextContent();
    const lines = pdfTextToLines(content.items as { str?: string; hasEOL?: boolean }[]);
    return lines.length > 0 ? await renderTextCard(filename, lines) : null;
  } finally {
    // destroy() on the loading task, not cleanup() on the proxy — the latter
    // frees caches but leaves the worker running.
    await loadingTask.destroy().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Text cards
//
// The rendition for anything whose content IS text: the file's own opening
// lines, typeset onto a page-shaped canvas. In a grid of cards this reads at a
// glance as "a document that starts like this", which is the entire job a
// thumbnail has — and it is real content, not a stylised icon pretending to be
// a preview.
// ---------------------------------------------------------------------------

const CARD_WIDTH = 1240;
const CARD_HEIGHT = 1600;
const CARD_PADDING = 64;
const CARD_LINE_HEIGHT = 34;
const CARD_FONT = '24px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const CARD_HEADER_FONT = '600 26px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const CARD_HEADER_HEIGHT = 88;

function renderTextCard(heading: string | null, lines: string[]): Promise<Blob | null> {
  return drawToJpeg(CARD_WIDTH, CARD_HEIGHT, (context, width, height) => {
    const scale = width / CARD_WIDTH;
    context.scale(scale, scale);
    const innerHeight = height / scale;

    let top = CARD_PADDING;
    if (heading) {
      context.fillStyle = '#f4f5f7';
      context.fillRect(0, 0, CARD_WIDTH, CARD_HEADER_HEIGHT);
      context.fillStyle = '#42526e';
      context.font = CARD_HEADER_FONT;
      context.textBaseline = 'middle';
      context.fillText(clipToWidth(context, heading, CARD_WIDTH - CARD_PADDING * 2), CARD_PADDING, CARD_HEADER_HEIGHT / 2);
      top = CARD_HEADER_HEIGHT + CARD_PADDING;
    }

    context.fillStyle = '#172b4d';
    context.font = CARD_FONT;
    context.textBaseline = 'top';
    const maxRows = Math.max(1, Math.floor((innerHeight - top - CARD_PADDING) / CARD_LINE_HEIGHT));
    const textWidth = CARD_WIDTH - CARD_PADDING * 2;

    // Wrap rather than clip. Minified JSON, single-line logs and long CSV rows
    // are common, and clipping each source line to one row turns those files
    // into a near-blank card with one truncated line on it.
    const rows: string[] = [];
    for (const line of lines) {
      for (const row of wrapLine(context, line, textWidth, maxRows - rows.length)) {
        rows.push(row);
      }
      if (rows.length >= maxRows) break;
    }

    rows.slice(0, maxRows).forEach((row, index) => {
      context.fillText(row, CARD_PADDING, top + index * CARD_LINE_HEIGHT);
    });
  });
}

// Greedily breaks one source line into rows that fit, stopping once `maxRows`
// have been produced — a 128 KB single-line file must not be laid out in full
// just to fill a card that shows forty rows.
function wrapLine(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxRows: number
): string[] {
  if (maxRows <= 0) return [];
  if (text.length === 0) return [''];

  const rows: string[] = [];
  let rest = text;
  while (rest.length > 0 && rows.length < maxRows) {
    if (context.measureText(rest).width <= maxWidth) {
      rows.push(rest);
      break;
    }
    // Largest prefix that still fits, by binary search on measured width.
    let low = 1;
    let high = rest.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (context.measureText(rest.slice(0, middle)).width <= maxWidth) low = middle;
      else high = middle - 1;
    }
    // Prefer a word boundary, but only when one is close to the break — for
    // minified content there is no space for thousands of characters, and
    // hunting for one would leave most of the row empty.
    let cut = Math.max(1, low);
    const lastSpace = rest.lastIndexOf(' ', cut);
    if (lastSpace > cut * 0.6) cut = lastSpace + 1;
    rows.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return rows;
}

// Truncates with an ellipsis by measuring — canvas has no text wrapping or
// clipping of its own, and an overlong line would otherwise run off the page.
function clipToWidth(context: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (context.measureText(text).width <= maxWidth) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (context.measureText(`${text.slice(0, middle)}…`).width <= maxWidth) low = middle;
    else high = middle - 1;
  }
  return `${text.slice(0, low)}…`;
}

// Only the head of the file is ever read: a 200 MB log renders from its first
// 128 KB exactly as well as from all of it, and slicing keeps the whole thing
// out of memory.
const TEXT_HEAD_BYTES = 128 * 1024;

async function readTextHead(source: Blob): Promise<string> {
  const head = await source.slice(0, TEXT_HEAD_BYTES).arrayBuffer();
  // fatal: false so a multi-byte character cut in half by the slice degrades to
  // a replacement character instead of throwing away the whole preview.
  return new TextDecoder('utf-8', { fatal: false }).decode(head);
}

function toDisplayLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    // Tabs render as a single narrow glyph on canvas, which destroys the
    // alignment that makes logs and TSV readable.
    .map((line) => line.replace(/\t/g, '    '));
}

async function renderTextFile(source: Blob, filename: string): Promise<Blob | null> {
  const text = await readTextHead(source);
  if (text.trim().length === 0) return null;
  return renderTextCard(filename, toDisplayLines(text));
}

// ---------------------------------------------------------------------------
// ZIP-backed formats: Office documents and archives
// ---------------------------------------------------------------------------

// Preview images the producing application embeds in the container. OOXML puts
// one in docProps (PowerPoint and LibreOffice always; Word and Excel when the
// author saved a thumbnail), OpenDocument always ships Thumbnails/thumbnail.png.
// Where the OOXML and OpenDocument families keep embedded pictures.
const EMBEDDED_MEDIA_PATTERN = /^(ppt|word|xl)\/media\/.+\.(png|jpe?g|gif|bmp|webp)$|^Pictures\/.+\.(png|jpe?g|gif|bmp|webp)$/i;

const EMBEDDED_THUMBNAIL_NAMES = [
  'docProps/thumbnail.jpeg',
  'docProps/thumbnail.jpg',
  'docProps/thumbnail.png',
  'Thumbnails/thumbnail.png',
  'Thumbnails/thumbnail.jpg',
];

// How many slides deep to look for something to show. A deck whose opening
// slide is a full-bleed image has no text in slide1.xml at all, and giving up
// there is the difference between a real preview and a bare icon.
const MAX_SLIDES_SCANNED = 5;

function slideNumber(name: string): number {
  const match = /slide(\d+)\.xml$/i.exec(name);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

// Where each Office family keeps the text we fall back to, with the element
// that ends a paragraph so line structure survives tag stripping. Built per
// file because PowerPoint stores every slide as its own part, so which parts
// exist is only knowable from the container itself.
function officeTextParts(entries: ZipEntry[]): { part: string; paragraphEnd: RegExp }[] {
  const slides = entries
    .map((entry) => entry.name)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((left, right) => slideNumber(left) - slideNumber(right))
    .slice(0, MAX_SLIDES_SCANNED);

  return [
    { part: 'word/document.xml', paragraphEnd: /<\/w:p>/g },
    ...slides.map((part) => ({ part, paragraphEnd: /<\/a:p>/g })),
    { part: 'content.xml', paragraphEnd: /<\/text:(p|h)>/g },
    { part: 'xl/sharedStrings.xml', paragraphEnd: /<\/si>/g },
  ];
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
    // Ampersand last, so an escaped "&amp;lt;" cannot become a tag.
    .replace(/&amp;/g, '&');
}

function xmlToLines(xml: string, paragraphEnd: RegExp): string[] {
  const text = decodeXmlEntities(xml.replace(paragraphEnd, '\n').replace(/<[^>]*>/g, ''));
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0);
}

async function renderOfficeDocument(source: Blob, filename: string): Promise<Blob | null> {
  const entries = await readZipEntries(source);
  if (!entries) return null;

  // Preferred: the real page image the authoring application already rendered
  // — but only when it actually shows something. See looksBlank: a generated
  // .pptx/.docx carries its template's blank white placeholder here, and
  // rendering that faithfully is how a card ends up empty.
  for (const name of EMBEDDED_THUMBNAIL_NAMES) {
    const embedded = await extractZipEntryByName(source, entries, name);
    if (!embedded) continue;
    try {
      const rendered = await renderEmbeddedPreview(embedded);
      if (rendered) return rendered;
    } catch {
      // A corrupt embedded image is not a reason to give up on the file — fall
      // through to the text path below.
    }
  }

  // Fallback: the document's own opening text. Less pretty than a page image
  // but still the file's actual content, which beats a generic icon.
  for (const { part, paragraphEnd } of officeTextParts(entries)) {
    const xmlBlob = await extractZipEntryByName(source, entries, part);
    if (!xmlBlob) continue;
    const lines = xmlToLines(await xmlBlob.text(), paragraphEnd);
    if (lines.length === 0) continue;
    return renderTextCard(filename, lines);
  }

  // Last resort, for documents that are pictures rather than prose: a deck of
  // diagrams, a scanned report, an architecture blueprint. These have no
  // usable text at all, so the biggest picture the container holds is in
  // practice what the document looks like — and far better than an icon.
  // Largest, not first, because the first is usually a logo or a bullet glyph.
  const media = entries
    .filter((entry) => EMBEDDED_MEDIA_PATTERN.test(entry.name))
    .sort((left, right) => right.uncompressedSize - left.uncompressedSize)[0];
  if (media) {
    const picture = await extractZipEntry(source, media);
    if (picture) {
      try {
        const rendered = await renderEmbeddedPreview(picture);
        if (rendered) return rendered;
      } catch {
        // Not decodable (EMF/WMF vector art is common in Office media folders).
      }
    }
  }

  return null;
}

// Exported so the archive PREVIEW can present the same listing the archive
// thumbnail shows, formatted identically, without a second implementation.
export function formatEntrySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function isDirectoryEntry(entry: ZipEntry): boolean {
  return entry.name.endsWith('/');
}

async function renderArchive(source: Blob, filename: string): Promise<Blob | null> {
  const entries = await readZipEntries(source);
  if (!entries || entries.length === 0) return null;
  const files = entries.filter((entry) => !isDirectoryEntry(entry));
  const heading = `${filename} — ${files.length} ${files.length === 1 ? 'file' : 'files'}`;
  const lines = files.map((entry) => `${entry.name}  ·  ${formatEntrySize(entry.uncompressedSize)}`);
  return renderTextCard(heading, lines);
}

// ---------------------------------------------------------------------------
// Audio waveforms
// ---------------------------------------------------------------------------

// Decoding materialises the whole track as float samples — roughly 10 MB of
// memory per minute of stereo CD-quality audio — so long recordings are left
// with their icon rather than risking the tab.
const MAX_AUDIO_DECODE_BYTES = 48 * 1024 * 1024;
const WAVEFORM_WIDTH = 1600;
const WAVEFORM_HEIGHT = 900;

function decodeAudio(context: OfflineAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  // Safari only implements the callback form; the promise form is standard
  // everywhere else. Supporting both is three lines.
  return new Promise((resolve, reject) => {
    const maybePromise = context.decodeAudioData(data, resolve, reject);
    if (maybePromise && typeof maybePromise.then === 'function') maybePromise.then(resolve, reject);
  });
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

async function renderAudioWaveform(source: Blob, filename: string): Promise<Blob | null> {
  if (source.size > MAX_AUDIO_DECODE_BYTES) return null;
  const Ctor: typeof OfflineAudioContext | undefined =
    (window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext ??
    (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!Ctor) return null;

  // A 1-frame context is enough to own decodeAudioData; nothing is rendered
  // through the graph itself, so its sample rate is irrelevant.
  const audio = await decodeAudio(new Ctor(1, 1, 44100), await source.arrayBuffer());
  const samples = audio.getChannelData(0);
  const bars = 240;
  const samplesPerBar = Math.max(1, Math.floor(samples.length / bars));

  // Peak per bar rather than an average: averaging flattens music into a
  // featureless block, while peaks keep the shape the ear expects.
  const peaks: number[] = [];
  for (let bar = 0; bar < bars; bar++) {
    let peak = 0;
    const start = bar * samplesPerBar;
    const end = Math.min(samples.length, start + samplesPerBar);
    for (let index = start; index < end; index++) {
      const value = Math.abs(samples[index]);
      if (value > peak) peak = value;
    }
    peaks.push(peak);
  }
  const loudest = Math.max(...peaks, 0.01);

  return drawToJpeg(WAVEFORM_WIDTH, WAVEFORM_HEIGHT, (context, width) => {
    const scale = width / WAVEFORM_WIDTH;
    context.scale(scale, scale);
    const middle = WAVEFORM_HEIGHT / 2;
    const barWidth = WAVEFORM_WIDTH / bars;

    context.fillStyle = '#dfe1e6';
    context.fillRect(0, middle - 1, WAVEFORM_WIDTH, 2);

    context.fillStyle = '#0052cc';
    peaks.forEach((peak, index) => {
      const barHeight = Math.max(3, (peak / loudest) * (WAVEFORM_HEIGHT * 0.38));
      context.fillRect(index * barWidth + 1, middle - barHeight, Math.max(1, barWidth - 2), barHeight * 2);
    });

    context.fillStyle = '#42526e';
    context.font = CARD_HEADER_FONT;
    context.textBaseline = 'alphabetic';
    context.fillText(
      clipToWidth(context, `${filename} — ${formatDuration(audio.duration)}`, WAVEFORM_WIDTH - 96),
      48,
      WAVEFORM_HEIGHT - 48
    );
  });
}

// ---------------------------------------------------------------------------
// URL-sourced renditions (video frames, SVG)
//
// Both draw a cross-origin resource into a canvas, which only yields readable
// pixels when the response carries CORS headers — the app's own buckets are
// provisioned with them (see bucketProvisioningService), so this works there.
// Against a location without CORS the canvas is tainted and toBlob throws
// SecurityError, which surfaces as FAILED and leaves the file's icon in place.
// ---------------------------------------------------------------------------

const URL_RENDER_TIMEOUT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), URL_RENDER_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function renderVideoFrameFromUrl(url: string): Promise<Blob | null> {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;

  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error('The video could not be loaded'));
        video.src = url;
      }),
      'Video load'
    );

    // A tenth of the way in, capped at one second: frame zero of a real
    // recording is very often a black or blank fade-in.
    const target = Number.isFinite(video.duration) ? Math.min(1, video.duration * 0.1) : 0;
    if (target > 0) {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          video.onseeked = () => resolve();
          video.onerror = () => reject(new Error('The video could not be seeked'));
          video.currentTime = target;
        }),
        'Video seek'
      );
    }

    return await drawToJpeg(video.videoWidth, video.videoHeight, (context, width, height) =>
      context.drawImage(video, 0, 0, width, height)
    );
  } finally {
    // Drop the source so the browser tears the decoder down straight away
    // instead of holding the whole stream open behind a detached element.
    video.onloadeddata = null;
    video.onseeked = null;
    video.onerror = null;
    video.removeAttribute('src');
    video.load();
  }
}

async function renderImageElementFromUrl(url: string): Promise<Blob | null> {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('The image could not be loaded'));
        image.src = url;
      }),
      'Image load'
    );

    // An SVG with only a viewBox has no intrinsic size; browsers report either
    // 0 or the 300x150 replaced-element default, neither of which makes a good
    // thumbnail. Fall back to a square that the drawImage below scales into.
    const width = image.naturalWidth > 300 ? image.naturalWidth : 1024;
    const height = image.naturalHeight > 150 ? image.naturalHeight : 1024;
    return await drawToJpeg(width, height, (context, canvasWidth, canvasHeight) =>
      context.drawImage(image, 0, 0, canvasWidth, canvasHeight)
    );
  } finally {
    // On a timeout the load is still in flight; detaching the handlers and the
    // source stops it rather than leaving a download running for a thumbnail
    // nobody is waiting for any more.
    image.onload = null;
    image.onerror = null;
    image.removeAttribute('src');
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Render a preview image for one file from its bytes, entirely in the browser.
 *
 * Never throws: a thumbnail is an enhancement, and a corrupt or oversized file
 * must not be able to fail the upload that carries it. Callers persist the
 * returned status verbatim — recording UNSUPPORTED/FAILED is what stops the
 * gallery retrying the same file on every render, and recording NULL (for the
 * URL-sourced categories) is what makes the backfill pick it up once the bytes
 * are at the storage location.
 */
export async function generateThumbnail(source: Blob, filename: string, mimeType?: string): Promise<ThumbnailResult> {
  if (!canRenderThumbnail(filename, mimeType)) return UNSUPPORTED;
  if (requiresUrlSource(filename, mimeType)) return DEFERRED;

  try {
    const blob = await renderByCategory(source, filename);
    return blob ? { blob, status: 'READY' } : FAILED;
  } catch (error) {
    console.warn(`[ProjectBucket] Thumbnail generation failed for "${filename}":`, error);
    return FAILED;
  }
}

async function renderByCategory(source: Blob, filename: string): Promise<Blob | null> {
  switch (classifyExtension(extensionOf(filename))) {
    case 'IMAGES':
      return renderImage(source);
    case 'PDF':
      return renderPdfFirstPage(source, filename);
    case 'DOCUMENTS':
      return renderTextFile(source, filename);
    case 'OFFICE':
      return renderOfficeDocument(source, filename);
    case 'ARCHIVES':
      return renderArchive(source, filename);
    case 'AUDIO':
      return renderAudioWaveform(source, filename);
    default:
      // Only reachable for the text/* fallback in canRenderThumbnail.
      return renderTextFile(source, filename);
  }
}

/**
 * Render a preview image from the stored object's URL, for the categories that
 * cannot be rendered from local bytes (see requiresUrlSource). Same contract as
 * generateThumbnail: never throws, always returns a status to persist.
 */
export async function generateThumbnailFromUrl(
  url: string,
  filename: string,
  mimeType?: string
): Promise<ThumbnailResult> {
  try {
    const category = classifyExtension(extensionOf(filename));
    let blob: Blob | null = null;
    if (category === 'VIDEOS') blob = await renderVideoFrameFromUrl(url);
    else if (isSvg(filename, mimeType)) blob = await renderImageElementFromUrl(url);
    else return UNSUPPORTED;
    return blob ? { blob, status: 'READY' } : FAILED;
  } catch (error) {
    console.warn(`[ProjectBucket] Thumbnail generation from URL failed for "${filename}":`, error);
    return FAILED;
  }
}

// Filename given to the generated object. It never reaches the user — the
// gallery always displays the attachment's own filename — but it does pass
// through the backend's stateless validators, which key off the extension.
export function thumbnailFilenameFor(filename: string): string {
  return `${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}.thumb.jpg`;
}
