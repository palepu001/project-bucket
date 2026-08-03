import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMigratedBlob } from './blobValidation';

// Coverage for the checks the Jira→Project Bucket migration runs on downloaded
// bytes before they are sent to the storage location. Before this existed the
// migration path ran NO validation at all: whatever Jira held went straight to
// the bucket, so a file the "Add Attachment" button would reject got in freely
// through the migration door.
// Run with: npm run test:watcher (from the repo root)
//
// This file is the panel suite re-pointed at the watcher's own copy of the
// validator. The two implementations are hand-duplicated (see blobValidation.ts
// for why), so they need identical expectations or they will drift apart
// silently and the auto-migration path will quietly stop checking something.

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function blobOf(bytes: number[], padTo = 0): Blob {
  const body = [...bytes];
  while (body.length < padTo) body.push(0);
  return new Blob([new Uint8Array(body)]);
}

test('a well-formed PNG passes', async () => {
  const result = await validateMigratedBlob(blobOf(PNG_MAGIC, 64), 'photo.png', 'image/png');
  assert.equal(result.passed, true);
});

test('an executable is blocked by the extension blocklist', async () => {
  const result = await validateMigratedBlob(blobOf([0x4d, 0x5a], 64), 'installer.exe', 'application/octet-stream');
  assert.equal(result.passed, false);
  assert.equal(result.passed === false && result.code, 'FORBIDDEN_EXTENSION');
});

test('a double extension disguising an executable is blocked', async () => {
  const result = await validateMigratedBlob(blobOf(PNG_MAGIC, 64), 'invoice.exe.png', 'image/png');
  assert.equal(result.passed, false);
  assert.equal(result.passed === false && result.code, 'FORBIDDEN_EXTENSION');
});

test('content that does not match its claimed extension is blocked', async () => {
  // Renaming to .png with RIFF bytes (not dangerous, just wrong for PNG).
  const result = await validateMigratedBlob(blobOf([0x52, 0x49, 0x46, 0x46], 64), 'payload.png', 'image/png');
  assert.equal(result.passed, false);
  assert.equal(result.passed === false && result.code, 'SIGNATURE_MISMATCH');
});

test('an empty file claiming a known format is blocked', async () => {
  const result = await validateMigratedBlob(new Blob([]), 'empty.png', 'image/png');
  assert.equal(result.passed, false);
  assert.equal(result.passed === false && result.code, 'SIGNATURE_EMPTY_FILE');
});

test('a denied MIME type is blocked even with an allowed extension', async () => {
  const result = await validateMigratedBlob(blobOf(PNG_MAGIC, 64), 'thing.png', 'application/x-msdownload');
  assert.equal(result.passed, false);
  assert.equal(result.passed === false && result.code, 'MIME_DENIED');
});

test('an unknown extension with harmless bytes is accepted', async () => {
  // .exr with random non-dangerous bytes — should pass through.
  const result = await validateMigratedBlob(blobOf([0x76, 0x2F, 0x31, 0x20], 64), 'plate.exr', 'application/octet-stream');
  assert.equal(result.passed, true);
});

test('a filename normalized before checking cannot smuggle a trailing-dot extension', async () => {
  // "report.png." normalizes to "report.png"; the check must run on the
  // normalized name so what is validated matches what gets stored.
  const result = await validateMigratedBlob(blobOf(PNG_MAGIC, 64), 'report.png.', 'image/png');
  assert.equal(result.passed, true);
});

test('binary content masquerading as .txt is blocked', async () => {
  const result = await validateMigratedBlob(blobOf([0x68, 0x69, 0x00, 0x68, 0x69]), 'notes.txt', 'text/plain');
  assert.equal(result.passed, false);
  assert.equal(result.passed === false && result.code, 'BINARY_CONTENT_MISMATCH');
});

test('an offset signature (mp4 ftyp box) is matched, not just byte 0', async () => {
  const bytes = [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d];
  const result = await validateMigratedBlob(blobOf(bytes), 'clip.mp4', 'video/mp4');
  assert.equal(result.passed, true);
});

test('mp4 content missing the ftyp box is blocked', async () => {
  const result = await validateMigratedBlob(blobOf([0x00, 0x00, 0x00, 0x18], 12), 'clip.mp4', 'video/mp4');
  assert.equal(result.passed, false);
  assert.equal(result.passed === false && result.code, 'SIGNATURE_MISMATCH');
});

test('an SVG containing an inline script is blocked', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  const result = await validateMigratedBlob(new Blob([svg]), 'icon.svg', 'image/svg+xml');
  assert.equal(result.passed, false);
  assert.equal(result.passed === false && result.code, 'SVG_UNSAFE_MARKUP');
});

test('a plain SVG with no script content is accepted', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>';
  const result = await validateMigratedBlob(new Blob([svg]), 'icon.svg', 'image/svg+xml');
  assert.equal(result.passed, true);
});

// --- Dangerous magic detection tests ---

test('a file with MZ header is blocked regardless of extension', async () => {
  // MZ header = Windows executable, even if the extension says .exr
  const result = await validateMigratedBlob(blobOf([0x4D, 0x5A, 0x90, 0x00], 64), 'scene.exr', 'application/octet-stream');
  assert.equal(result.passed, false);
  assert.equal(result.passed === false && result.code, 'DANGEROUS_CONTENT');
});

test('a file with ELF header is blocked regardless of extension', async () => {
  const result = await validateMigratedBlob(blobOf([0x7F, 0x45, 0x4C, 0x46], 64), 'model.blend', 'application/octet-stream');
  assert.equal(result.passed, false);
  assert.equal(result.passed === false && result.code, 'DANGEROUS_CONTENT');
});

test('a file with shebang is blocked regardless of extension', async () => {
  const result = await validateMigratedBlob(blobOf([0x23, 0x21, 0x2F, 0x62, 0x69, 0x6E], 64), 'data.csv', 'text/csv');
  assert.equal(result.passed, false);
  assert.equal(result.passed === false && result.code, 'DANGEROUS_CONTENT');
});

test('an .exr file with legitimate (non-dangerous) bytes passes', async () => {
  // OpenEXR magic number: 0x76, 0x2F, 0x31, 0x01 — not in any dangerous list.
  const result = await validateMigratedBlob(blobOf([0x76, 0x2F, 0x31, 0x01], 64), 'render.exr', 'application/octet-stream');
  assert.equal(result.passed, true);
});
