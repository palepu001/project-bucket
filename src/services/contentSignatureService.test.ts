import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertStoredObjectMatchesFilename } from './contentSignatureService';
import { AttachmentStorageProvider } from '../storage/AttachmentStorageProvider';

function fakeProvider(bytes: number[] | null): AttachmentStorageProvider {
  return {
    containerName: 'test-bucket',
    upload: async () => ({ url: 'https://example.invalid/upload' }),
    download: async () => ({ url: 'https://example.invalid/download' }),
    stream: async () => null,
    readHeaderBytes: async () => (bytes === null ? null : new Uint8Array(bytes)),
    delete: async () => undefined,
    exists: async () => [],
  };
}

test('stored object signature passes when bytes match the claimed extension', async () => {
  await assert.doesNotReject(
    assertStoredObjectMatchesFilename(fakeProvider([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'key', 'image.png')
  );
});

test('stored object signature rejects a spoofed extension', async () => {
  await assert.rejects(
    assertStoredObjectMatchesFilename(fakeProvider([0x54, 0x68, 0x69, 0x73]), 'key', 'image.png'),
    /failed content validation/
  );
});

test('stored object signature accepts plain text for an extension with no fixed magic bytes', async () => {
  await assert.doesNotReject(
    assertStoredObjectMatchesFilename(fakeProvider([0x54, 0x68, 0x69, 0x73]), 'key', 'notes.txt')
  );
});

test('stored object signature rejects binary content masquerading as a text extension', async () => {
  await assert.rejects(
    assertStoredObjectMatchesFilename(fakeProvider([0x54, 0x68, 0x00, 0x69, 0x73]), 'key', 'notes.txt'),
    /contains binary data/
  );
});

function padded(bytes: number[], length: number): number[] {
  const out = bytes.slice();
  while (out.length < length) out.push(0x41);
  return out;
}

test('stored object signature matches an offset signature (mp4 ftyp box)', async () => {
  const bytes = [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d];
  await assert.doesNotReject(assertStoredObjectMatchesFilename(fakeProvider(bytes), 'key', 'clip.mp4'));
});

test('stored object signature rejects content missing the offset signature (mp4)', async () => {
  await assert.rejects(
    assertStoredObjectMatchesFilename(fakeProvider(padded([0x00, 0x00, 0x00, 0x18], 12)), 'key', 'clip.mp4'),
    /failed content validation/
  );
});

test('stored object signature matches an offset signature far into the header (tar ustar)', async () => {
  const bytes = padded([], 257).concat([0x75, 0x73, 0x74, 0x61, 0x72]);
  await assert.doesNotReject(assertStoredObjectMatchesFilename(fakeProvider(bytes), 'key', 'archive.tar'));
});

test('stored object signature rejects a tar file missing the ustar magic', async () => {
  await assert.rejects(
    assertStoredObjectMatchesFilename(fakeProvider(padded([], 262)), 'key', 'archive.tar'),
    /failed content validation/
  );
});

test('stored object signature rejects an SVG containing an inline script', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  const bytes = Array.from(new TextEncoder().encode(svg));
  await assert.rejects(
    assertStoredObjectMatchesFilename(fakeProvider(bytes), 'key', 'icon.svg'),
    /may not contain scripts/
  );
});

test('stored object signature rejects an SVG with an event-handler attribute', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle onload="alert(1)" r="1"/></svg>';
  const bytes = Array.from(new TextEncoder().encode(svg));
  await assert.rejects(
    assertStoredObjectMatchesFilename(fakeProvider(bytes), 'key', 'icon.svg'),
    /may not contain scripts/
  );
});

test('stored object signature accepts a plain SVG with no script content', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>';
  const bytes = Array.from(new TextEncoder().encode(svg));
  await assert.doesNotReject(assertStoredObjectMatchesFilename(fakeProvider(bytes), 'key', 'icon.svg'));
});
