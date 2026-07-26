import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMigratedBlob } from './blobValidation';

// Coverage for the checks the Jira→Project Bucket migration runs on downloaded
// bytes before they are sent to the storage location. Before this existed the
// migration path ran NO validation at all: whatever Jira held went straight to
// the bucket, so a file the "Add Attachment" button would reject got in freely
// through the migration door.
// Run with: npm test (inside static/panel)

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

test('an executable is blocked by the extension whitelist', async () => {
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
  // Renaming an executable to .png gets past the whitelist but not the magic
  // number check — this is the case only a byte-level check can catch.
  const result = await validateMigratedBlob(blobOf([0x4d, 0x5a, 0x90, 0x00], 64), 'payload.png', 'image/png');
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

test('an allowed extension with no magic number is accepted on the whitelist alone', async () => {
  const result = await validateMigratedBlob(new Blob(['hello,world']), 'data.csv', 'text/csv');
  assert.equal(result.passed, true);
});

test('a filename normalized before checking cannot smuggle a trailing-dot extension', async () => {
  // "report.png." normalizes to "report.png"; the check must run on the
  // normalized name so what is validated matches what gets stored.
  const result = await validateMigratedBlob(blobOf(PNG_MAGIC, 64), 'report.png.', 'image/png');
  assert.equal(result.passed, true);
});
