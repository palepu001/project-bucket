import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractZipEntryByName, readZipEntries } from './zip';

// The ZIP reader is what gives Office documents and archives a real preview
// image instead of a generic icon, and it parses byte offsets out of untrusted
// files — so it is worth testing directly rather than only through the browser.
// Everything it uses (Blob, DataView, DecompressionStream) exists in Node, so
// these run headlessly alongside the rest of the suite.
//
// This file is the single copy under test; static/panel/src/utils/zip.ts is
// byte-identical (see the duplication note in migrationClient.ts).

interface Member {
  name: string;
  content: Uint8Array;
  deflate?: boolean;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Builds a minimal but spec-shaped ZIP archive in memory. */
async function buildZip(members: Member[]): Promise<Blob> {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const member of members) {
    const name = bytes(member.name);
    const stored = member.deflate ? await deflateRaw(member.content) : member.content;
    const method = member.deflate ? 8 : 0;

    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(8, method, true);
    localView.setUint32(18, stored.length, true);
    localView.setUint32(22, member.content.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);

    const record = new Uint8Array(46 + name.length);
    const recordView = new DataView(record.buffer);
    recordView.setUint32(0, 0x02014b50, true);
    recordView.setUint16(10, method, true);
    recordView.setUint32(20, stored.length, true);
    recordView.setUint32(24, member.content.length, true);
    recordView.setUint16(28, name.length, true);
    recordView.setUint32(42, offset, true);
    record.set(name, 46);
    central.push(record);

    chunks.push(local, stored);
    offset += local.length + stored.length;
  }

  const directorySize = central.reduce((total, record) => total + record.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, members.length, true);
  eocdView.setUint16(10, members.length, true);
  eocdView.setUint32(12, directorySize, true);
  eocdView.setUint32(16, offset, true);

  return new Blob([...chunks, ...central, eocd] as BlobPart[]);
}

test('lists every member with its real uncompressed size', async () => {
  const zip = await buildZip([
    { name: 'docProps/thumbnail.jpeg', content: bytes('not-really-a-jpeg') },
    { name: 'word/document.xml', content: bytes('<w:p>Hello</w:p>'), deflate: true },
    { name: 'nested/', content: new Uint8Array(0) },
  ]);

  const entries = await readZipEntries(zip);
  assert.ok(entries);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['docProps/thumbnail.jpeg', 'word/document.xml', 'nested/']
  );
  assert.equal(entries[1].uncompressedSize, '<w:p>Hello</w:p>'.length);
  // The listing thumbnail marks directories by their trailing slash, so that
  // distinction has to survive parsing.
  assert.ok(entries[2].name.endsWith('/'));
});

test('extracts a stored member byte for byte', async () => {
  const zip = await buildZip([
    { name: 'first.txt', content: bytes('first') },
    { name: 'Thumbnails/thumbnail.png', content: bytes('png-bytes-here') },
  ]);
  const entries = await readZipEntries(zip);
  assert.ok(entries);

  // Reading the SECOND member also proves the local-header offset is honoured
  // rather than the reader simply returning the first entry it finds.
  const extracted = await extractZipEntryByName(zip, entries, 'Thumbnails/thumbnail.png');
  assert.ok(extracted);
  assert.equal(await extracted.text(), 'png-bytes-here');
});

test('inflates a deflated member', async () => {
  const xml = `<?xml version="1.0"?><w:document>${'<w:p>paragraph</w:p>'.repeat(50)}</w:document>`;
  const zip = await buildZip([{ name: 'word/document.xml', content: bytes(xml), deflate: true }]);
  const entries = await readZipEntries(zip);
  assert.ok(entries);

  const extracted = await extractZipEntryByName(zip, entries, 'word/document.xml');
  assert.ok(extracted);
  assert.equal(await extracted.text(), xml);
});

test('member lookup is case-insensitive and misses return null, never throw', async () => {
  const zip = await buildZip([{ name: 'DocProps/Thumbnail.JPEG', content: bytes('x') }]);
  const entries = await readZipEntries(zip);
  assert.ok(entries);

  assert.ok(await extractZipEntryByName(zip, entries, 'docProps/thumbnail.jpeg'));
  assert.equal(await extractZipEntryByName(zip, entries, 'docProps/absent.png'), null);
});

test('a file that is not a ZIP is declined rather than throwing', async () => {
  // Every caller treats null as "keep the file's icon", so the parser must
  // never propagate an exception into the thumbnail pipeline.
  assert.equal(await readZipEntries(new Blob([bytes('this is a plain text file')] as BlobPart[])), null);
  assert.equal(await readZipEntries(new Blob([] as BlobPart[])), null);
});

test('a truncated archive is declined rather than half-read', async () => {
  const zip = await buildZip([{ name: 'a.txt', content: bytes('aaaa') }]);
  // Cutting the tail removes the End Of Central Directory record, which is the
  // only thing that says where the listing lives.
  assert.equal(await readZipEntries(zip.slice(0, zip.size - 10)), null);
});
