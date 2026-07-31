// Minimal store-only (compression method 0) ZIP writer.
//
// Deliberately NOT deflate: every file the gallery holds is already a
// compressed container (png/jpg/pdf/mp4/zip/docx…), so re-compressing them buys
// almost nothing and would mean shipping a deflate implementation into the
// iframe. Store-only keeps this a few dozen lines with no dependency, and the
// "Download all" ZIP is a transport bundle, not an archive meant to shrink
// anything.
//
// Counterpart to utils/zip.ts, which READS zips (the thumbnail/preview path);
// this one only WRITES them and is used solely by the bulk-download service.
//
// Limits: no Zip64, so a single member above 4 GB or a total archive above 4 GB
// is rejected with a clear error rather than silently producing a corrupt file.
// That ceiling is far past what a browser can hold in memory anyway.

const MAX_ZIP_SIZE = 0xffffffff;

let crcTable: Uint32Array | null = null;
function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

function crc32(data: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): Uint8Array {
  const b = new Uint8Array(2);
  b[0] = value & 0xff;
  b[1] = (value >>> 8) & 0xff;
  return b;
}

function u32(value: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = value & 0xff;
  b[1] = (value >>> 8) & 0xff;
  b[2] = (value >>> 16) & 0xff;
  b[3] = (value >>> 24) & 0xff;
  return b;
}

export interface ZipInputEntry {
  name: string;
  data: Uint8Array;
}

// De-duplicates member names the way most desktop unzippers present a clash:
// "report.pdf", "report (1).pdf", "report (2).pdf". Two attachments on one
// issue can legitimately share a filename, and a zip with duplicate names
// extracts unpredictably.
function uniquify(name: string, seen: Set<string>): string {
  if (!seen.has(name)) {
    seen.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let counter = 1;
  let candidate = `${base} (${counter})${ext}`;
  while (seen.has(candidate)) {
    counter += 1;
    candidate = `${base} (${counter})${ext}`;
  }
  seen.add(candidate);
  return candidate;
}

/**
 * Builds a store-only ZIP from the given entries and returns it as a Blob ready
 * to hand to a browser download. Throws if the archive would exceed the 4 GB
 * no-Zip64 ceiling.
 */
export function buildZip(entries: ZipInputEntry[]): Blob {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  const seenNames = new Set<string>();
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(uniquify(entry.name, seenNames));
    const data = entry.data;
    const crc = crc32(data);
    const size = data.length;

    if (offset + 30 + nameBytes.length + size > MAX_ZIP_SIZE) {
      throw new Error('The selected files are too large to bundle into a single ZIP in the browser.');
    }

    // Local file header. General-purpose flag bit 11 (0x0800) marks the
    // filename as UTF-8; mod time/date are left zero (unzippers accept it).
    parts.push(u32(0x04034b50));
    parts.push(u16(20)); // version needed
    parts.push(u16(0x0800)); // flags: UTF-8 name
    parts.push(u16(0)); // method: store
    parts.push(u16(0)); // mod time
    parts.push(u16(0)); // mod date
    parts.push(u32(crc));
    parts.push(u32(size)); // compressed size (== uncompressed for store)
    parts.push(u32(size)); // uncompressed size
    parts.push(u16(nameBytes.length));
    parts.push(u16(0)); // extra length
    parts.push(nameBytes);
    parts.push(data);

    // Central directory record, emitted after all locals below.
    const record: Uint8Array[] = [];
    record.push(u32(0x02014b50));
    record.push(u16(20)); // version made by
    record.push(u16(20)); // version needed
    record.push(u16(0x0800)); // flags
    record.push(u16(0)); // method
    record.push(u16(0)); // mod time
    record.push(u16(0)); // mod date
    record.push(u32(crc));
    record.push(u32(size));
    record.push(u32(size));
    record.push(u16(nameBytes.length));
    record.push(u16(0)); // extra length
    record.push(u16(0)); // comment length
    record.push(u16(0)); // disk number start
    record.push(u16(0)); // internal attrs
    record.push(u32(0)); // external attrs
    record.push(u32(offset)); // local header offset
    record.push(nameBytes);
    central.push(concat(record));

    offset += 30 + nameBytes.length + size;
  }

  const centralBytes = concat(central);
  const centralOffset = offset;
  const centralSize = centralBytes.length;

  if (centralOffset + centralSize > MAX_ZIP_SIZE) {
    throw new Error('The selected files are too large to bundle into a single ZIP in the browser.');
  }

  // End of central directory record.
  const eocd: Uint8Array[] = [];
  eocd.push(u32(0x06054b50));
  eocd.push(u16(0)); // this disk
  eocd.push(u16(0)); // disk with central dir
  eocd.push(u16(entries.length)); // entries on this disk
  eocd.push(u16(entries.length)); // total entries
  eocd.push(u32(centralSize));
  eocd.push(u32(centralOffset));
  eocd.push(u16(0)); // comment length

  return new Blob([concat(parts), centralBytes, concat(eocd)], { type: 'application/zip' });
}

// Returns a Uint8Array explicitly backed by an ArrayBuffer (not the wider
// ArrayBufferLike), which is what Blob's BlobPart requires under TS's typed-
// array generics — `new Uint8Array(n)` is always ArrayBuffer-backed.
function concat(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}
