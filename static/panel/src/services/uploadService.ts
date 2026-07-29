
import { SequentialHashEngine } from '../security/SequentialHashEngine';
import * as api from '../api/resolvers';
import { Attachment, AttachmentThumbnailStatus } from '../types';
import { createDefaultPipeline } from '../security';
import { generateThumbnail, thumbnailFilenameFor, ThumbnailResult } from './thumbnailService';

export interface UploadOutcome {
  created: Attachment[];
  failed: { filename: string; error: string }[];
}

// The validation pipeline is created once and reused across all uploads —
// validators are stateless, so a single instance is safe for the lifetime
// of the panel. This avoids re-constructing the validator chain on every
// upload while keeping the pipeline's execution order frozen.
const validationPipeline = createDefaultPipeline();

/**
 * Drives the "Add Attachment" flow with pre-upload validation (F5).
 *
 * FLOW:
 *   1. For each file, run the validation pipeline (filename, extension,
 *      MIME, size, magic number, malware scan). This happens entirely
 *      client-side before any bytes leave the browser.
 *   2. Files that fail validation are added to the `failed` array with a
 *      user-facing error message — they are NEVER uploaded.
 *   3. Render a preview image for each surviving file while its bytes are
 *      still in memory here (see thumbnailService).
 *   4. Files AND their thumbnails go to storage in ONE 'uploadObjects' batch,
 *      which mints the transfer targets the browser then PUTs to.
 *   5. Metadata is persisted in ONE 'recordAttachments' call, which
 *      re-verifies the objects exist and inserts them in a single statement.
 *
 * Steps 4 and 5 are each exactly one round-trip regardless of file count: the
 * upload-session invariant is 1 upload action = 1 session = 1 transaction, so
 * nothing here may become a per-attachment call.
 *
 * The UploadOutcome type and function signature are unchanged — callers
 * (UploadButton.tsx) see no difference except that failures now include
 * validation errors in addition to upload errors.
 */
export async function uploadFiles(files: File[], issueId: string, projectId: string): Promise<UploadOutcome> {
  // --- Phase 1: Validate every file before any upload begins. ---
  // Validation runs sequentially per file (the pipeline itself is sequential),
  // but we validate all files up front so the user sees every validation
  // failure at once, not one at a time.
  const validFiles: File[] = [];
  const failed: { filename: string; error: string }[] = [];

  for (const file of files) {
    const result = await validationPipeline.run(file);
    if (!result.passed) {
      // The pipeline's message is user-facing and safe to display — no
      // stack traces, no internal details. See security/types.ts.
      failed.push({ filename: file.name, error: result.message });
    } else {
      validFiles.push(file);
    }
  }

  // If no files passed validation, return early — no upload attempt at all.
  if (validFiles.length === 0) {
    return { created: [], failed };
  }

  // --- Phase 2: Render thumbnails, still entirely client-side. ---
  // Done here, before any bytes move, because the File is already in memory —
  // the rendition costs no extra download. Generation never throws (see
  // thumbnailService), so a corrupt file still uploads, just without a preview.
  const thumbnails = await Promise.all(
    validFiles.map((file) => generateThumbnail(file, file.name, file.type))
  );

  // --- Phase 3: Upload files AND their thumbnails in one batch. ---
  // The upload-session invariant is 1 upload action = 1 session = 1 transaction,
  // so thumbnails must ride along in the SAME uploadObjects call rather than
  // adding a round-trip per attachment. Files occupy the first validFiles.length
  // slots; each generated thumbnail is appended after them and mapped back by
  // index via `thumbnailSlotOf`.
  const thumbnailBlobs = thumbnails
    .map((thumbnail, index) => ({ thumbnail, index }))
    .filter((entry): entry is { thumbnail: ThumbnailResult & { blob: Blob }; index: number } => entry.thumbnail.blob !== null);

  const thumbnailSlotOf = new Map<number, number>();
  thumbnailBlobs.forEach((entry, slot) => thumbnailSlotOf.set(entry.index, validFiles.length + slot));

  const thumbnailFiles = thumbnailBlobs.map((entry) => entry.thumbnail.blob);
  const checksums = await SequentialHashEngine.computeHashes([...validFiles, ...thumbnailFiles]);

  // Backend payload validation boundary. We invoke the resolver manually
  // rather than using objectStore.upload so we can pass the filename and mimeType.
  const payloadObjects = [
    ...validFiles.map((f, i) => ({
      filename: f.name,
      size: f.size,
      mimeType: f.type || 'application/octet-stream',
      checksum: checksums[i],
    })),
    ...thumbnailBlobs.map((entry, slot) => ({
      filename: thumbnailFilenameFor(validFiles[entry.index].name),
      size: entry.thumbnail.blob.size,
      mimeType: 'image/jpeg',
      checksum: checksums[validFiles.length + slot],
    })),
  ];

  const results = await api.invokeResolver<any>('uploadObjects', { objects: payloadObjects, issueId, projectId });

  async function putObject(body: Blob, result: any): Promise<boolean> {
    if (!result || !result.success) return false;
    const response = await fetch(result.url, { 
      method: result.method || 'PUT', 
      body, 
      headers: result.headers || {} 
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }
    return true;
  }

  const succeeded: {
    file: File;
    key: string;
    checksum: string;
    thumbnailKey: string | null;
    // Null for the categories that can only be rendered once their bytes are at
    // the storage location (video, SVG). It persists as "not attempted", which
    // is exactly what makes the gallery's backfill finish the job on first view.
    thumbnailStatus: AttachmentThumbnailStatus | null;
  }[] = [];

  for (let i = 0; i < validFiles.length; i++) {
    const file = validFiles[i];
    const result = results[i];

    if (!result || !result.success) {
      failed.push({ filename: file.name, error: result?.message || 'Backend validation rejected the payload' });
      continue;
    }

    try {
      await putObject(file, result);
    } catch (err: any) {
      failed.push({ filename: file.name, error: err.message || 'Network error uploading to storage backend' });
      continue;
    }

    // The thumbnail is uploaded after its file so a thumbnail-only failure can
    // never cost us the attachment — we just record it as FAILED and move on.
    // The key is only recorded once the PUT has actually succeeded; recording a
    // key for bytes that never landed would leave the gallery pointing at a
    // 404 with no way to notice it had happened.
    let thumbnailKey: string | null = null;
    let thumbnailStatus = thumbnails[i].status;
    const slot = thumbnailSlotOf.get(i);
    if (slot !== undefined) {
      try {
        if (await putObject(thumbnails[i].blob!, results[slot])) {
          thumbnailKey = results[slot].key;
        } else {
          thumbnailStatus = 'FAILED';
        }
      } catch (err) {
        thumbnailStatus = 'FAILED';
      }
    }

    succeeded.push({ file, key: result.key, checksum: checksums[i], thumbnailKey, thumbnailStatus });
  }

  if (succeeded.length === 0) {
    return { created: [], failed };
  }

  // --- Phase 4: Persist metadata for successfully uploaded files. ---
  // One call, one transaction on the backend (see insertAttachments).
  const created = await api.recordAttachments({
    issueId,
    projectId,
    items: succeeded.map((item) => ({
      key: item.key,
      filename: item.file.name,
      size: item.file.size,
      mimeType: item.file.type || 'application/octet-stream',
      checksum: item.checksum,
      thumbnailKey: item.thumbnailKey,
      thumbnailStatus: item.thumbnailStatus,
    })),
  });

  return { created, failed };
}
