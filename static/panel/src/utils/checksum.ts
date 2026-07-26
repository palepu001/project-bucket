// SHA-256 checksum, base64-encoded, computed entirely in-browser via the
// Web Crypto API. This is what storage backend's presigned-upload
// contract requires (see storage/AttachmentStorageProvider.ts on the
// backend) — the checksum must be known BEFORE the presigned URL is minted,
// so it always has to be computed client-side before the upload resolver is
// ever called.
export async function sha256Base64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  const bytes = new Uint8Array(digest);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
