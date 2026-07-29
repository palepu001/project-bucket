// A deliberately small ZIP reader, used by the thumbnail pipeline.
//
// Two very different file families in Project Bucket are ZIP containers under
// the covers, and both can therefore be given a real preview image instead of
// a generic icon:
//
//   OFFICE   — .docx/.pptx/.xlsx (OOXML) and .odt/.odp/.ods (OpenDocument)
//              carry either a ready-made preview image (`docProps/thumbnail.*`,
//              `Thumbnails/thumbnail.png`) or, failing that, the document text
//              in an XML part we can read and render ourselves.
//   ARCHIVES — .zip itself, whose central directory is a listing we can render.
//
// Why hand-rolled rather than a library: the panel and the watcher are two
// independently bundled Custom UI resources, and every dependency is shipped
// twice into an iframe the user waits on. Everything below needs only the
// platform (Blob.slice, DataView, DecompressionStream), and reads ONLY the
// bytes it needs — the central directory lives in the tail of the file, so
// listing a 200 MB archive downloads a few kilobytes of it, not 200 MB.
//
// Every function returns null rather than throwing on anything it does not
// understand (Zip64, encrypted entries, a truncated file, an unsupported
// compression method). A thumbnail is an enhancement; a file we cannot parse
// simply keeps its icon.

export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate. Anything else we decline to extract. */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Offset of this entry's LOCAL file header within the archive. */
  localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

// The End Of Central Directory record is 22 bytes plus a comment of up to
// 64 KB, and it is the LAST thing in the file — so the whole record is
// guaranteed to live in the final 64 KB + 22 bytes.
const EOCD_MAX_TAIL = 65_557;

// Guard rails. A malformed (or hostile) archive must not be able to make the
// panel allocate unbounded memory: we cap how much central directory we read
// and how large a single extracted member may be.
const MAX_CENTRAL_DIRECTORY_BYTES = 4 * 1024 * 1024;
const MAX_MEMBER_BYTES = 16 * 1024 * 1024;

async function sliceBytes(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

function findEocdOffset(tail: Uint8Array): number {
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  // Scan backwards: the signature can legitimately appear inside the archive's
  // data, so the LAST occurrence is the real record.
  for (let offset = tail.byteLength - 22; offset >= 0; offset--) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

/**
 * Lists an archive's members by reading only its central directory.
 * Returns null when the blob is not a ZIP we can read.
 */
export async function readZipEntries(blob: Blob): Promise<ZipEntry[] | null> {
  try {
    const tailStart = Math.max(0, blob.size - EOCD_MAX_TAIL);
    const tail = await sliceBytes(blob, tailStart, blob.size);
    const eocdOffset = findEocdOffset(tail);
    if (eocdOffset === -1) return null;

    const eocd = new DataView(tail.buffer, tail.byteOffset + eocdOffset, tail.byteLength - eocdOffset);
    const entryCount = eocd.getUint16(10, true);
    const directorySize = eocd.getUint32(12, true);
    const directoryOffset = eocd.getUint32(16, true);

    // 0xFFFF/0xFFFFFFFF are the Zip64 "look in the Zip64 record instead"
    // sentinels. Supporting Zip64 would double this file for archives no one
    // previews; decline cleanly instead.
    if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      return null;
    }
    if (directorySize > MAX_CENTRAL_DIRECTORY_BYTES) return null;
    if (directoryOffset + directorySize > blob.size) return null;

    const directory = await sliceBytes(blob, directoryOffset, directoryOffset + directorySize);
    const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
    const utf8 = new TextDecoder('utf-8');

    const entries: ZipEntry[] = [];
    let cursor = 0;
    for (let i = 0; i < entryCount; i++) {
      if (cursor + 46 > directory.byteLength) break;
      if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) break;

      const method = view.getUint16(cursor + 10, true);
      const compressedSize = view.getUint32(cursor + 20, true);
      const uncompressedSize = view.getUint32(cursor + 24, true);
      const nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const commentLength = view.getUint16(cursor + 32, true);
      const localHeaderOffset = view.getUint32(cursor + 42, true);
      const name = utf8.decode(directory.subarray(cursor + 46, cursor + 46 + nameLength));

      entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
      cursor += 46 + nameLength + extraLength + commentLength;
    }

    return entries;
  } catch {
    return null;
  }
}

async function inflateRaw(data: Uint8Array): Promise<Blob | null> {
  if (typeof DecompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return await new Response(stream).blob();
  } catch {
    return null;
  }
}

/**
 * Extracts one member's bytes. Returns null for encrypted members, compression
 * methods other than store/deflate, and anything over MAX_MEMBER_BYTES.
 */
export async function extractZipEntry(blob: Blob, entry: ZipEntry): Promise<Blob | null> {
  try {
    if (entry.uncompressedSize > MAX_MEMBER_BYTES) return null;
    if (entry.method !== 0 && entry.method !== 8) return null;

    // The central directory records where the LOCAL header is, but the local
    // header's own name/extra lengths are what say where the data begins —
    // they are allowed to differ from the central copy, so read them here.
    const header = await sliceBytes(blob, entry.localHeaderOffset, entry.localHeaderOffset + 30);
    if (header.byteLength < 30) return null;
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (view.getUint32(0, true) !== LOCAL_SIGNATURE) return null;
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);

    const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > blob.size) return null;

    const compressed = await sliceBytes(blob, dataStart, dataEnd);
    if (entry.method === 0) return new Blob([compressed as BlobPart]);
    return await inflateRaw(compressed);
  } catch {
    return null;
  }
}

/** Convenience: find + extract one member by exact (case-insensitive) name. */
export async function extractZipEntryByName(
  blob: Blob,
  entries: ZipEntry[],
  name: string
): Promise<Blob | null> {
  const wanted = name.toLowerCase();
  const entry = entries.find((candidate) => candidate.name.toLowerCase() === wanted);
  if (!entry) return null;
  return extractZipEntry(blob, entry);
}
