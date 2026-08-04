import { sha256 } from 'js-sha256';

// SHA-256 checksum, base64-encoded, computed entirely in-browser.
// Read and digested chunk-by-chunk to prevent Out Of Memory (OOM) crashes on large files.
export async function sha256Base64(blob: Blob): Promise<string> {
  const hash = sha256.create();
  const chunkSize = 2 * 1024 * 1024; // 2MB chunks
  let offset = 0;

  while (offset < blob.size) {
    const chunk = blob.slice(offset, offset + chunkSize);
    const buffer = await chunk.arrayBuffer();
    hash.update(buffer);
    offset += chunkSize;
  }

  const bytes = hash.array();
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
