/**
 * Resolves [BUG-02] (Browser OOM).
 * 
 * Computes hashes strictly sequentially instead of using Promise.all.
 * This ensures that only one file's ArrayBuffer is in memory at a time,
 * which allows the garbage collector to reclaim memory between iterations,
 * preventing OOM crashes on large batches.
 */
export const SequentialHashEngine = {
  // Blob rather than File: generated thumbnails are hashed through this same
  // path, and only arrayBuffer() is ever needed.
  async computeHashes(files: Blob[]): Promise<string[]> {
    const hashes: string[] = [];
    for (const file of files) {
      const buffer = await file.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      const bytes = new Uint8Array(digest);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      hashes.push(btoa(binary));
    }
    return hashes;
  }
};
