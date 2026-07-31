import * as api from '../api/resolvers';
import { Attachment } from '../types';
import { runWithConcurrency } from '../utils/concurrency';
import { buildZip, ZipInputEntry } from '../utils/zipWriter';
import { triggerBlobDownload } from '../utils/download';

// "Download all": pull every attachment's bytes back into the browser and hand
// the user ONE store-only ZIP (see utils/zipWriter). There is no server-side
// zip endpoint — the storage contract streams single objects — so the bundle is
// necessarily assembled client-side, which is why this is the only bulk action
// that materialises whole files in memory.

const BULK_DOWNLOAD_CONCURRENCY = 4;

// The backend content proxy's cap (MAX_PROXY_BYTES in the resolver). Only the
// fallback path is bounded by it; the direct presigned fetch has no ceiling.
const MAX_PROXY_BYTES = 10 * 1024 * 1024;

export interface BulkDownloadResult {
  zipped: number;
  failed: { filename: string; error: string }[];
}

/**
 * Fetches one attachment's bytes. Mirrors the gallery backfill's two routes: a
 * direct fetch of the presigned URL first (buckets are CORS-provisioned, so
 * this is the normal path and has no size limit), falling back to the backend
 * content proxy for a location without CORS — which caps at 10 MB, so larger
 * files on a non-CORS bucket are reported as failed rather than silently
 * truncated.
 */
async function fetchAttachmentBytes(attachment: Attachment): Promise<Uint8Array | null> {
  const target = await api.getDownloadUrl(attachment.id, 'inline');
  if (!target.unavailable && target.url) {
    try {
      const response = await fetch(target.url);
      if (response.ok) return new Uint8Array(await response.arrayBuffer());
    } catch {
      // CORS or a transient failure — fall through to the proxy.
    }
  }
  if (attachment.size > MAX_PROXY_BYTES) return null;
  const content = await api.getFileContent(attachment.id);
  if (!content.dataUrl) return null;
  return new Uint8Array(await (await fetch(content.dataUrl)).arrayBuffer());
}

/**
 * Downloads every given attachment as a single ZIP. Bytes are fetched
 * concurrently; a file whose bytes cannot be retrieved is recorded in `failed`
 * and skipped rather than aborting the whole bundle. The ZIP is only triggered
 * when at least one file was retrieved.
 *
 * The caller is expected to have fetched the definitive, unfiltered list of the
 * issue's attachments — "Download all" is issue-scoped, never limited to the
 * current search/category filter.
 */
export async function downloadAllAsZip(
  attachments: Attachment[],
  zipFilename: string
): Promise<BulkDownloadResult> {
  const entries: ZipInputEntry[] = [];
  const failed: { filename: string; error: string }[] = [];

  await runWithConcurrency(attachments, BULK_DOWNLOAD_CONCURRENCY, async (attachment) => {
    try {
      const bytes = await fetchAttachmentBytes(attachment);
      if (!bytes) {
        failed.push({ filename: attachment.filename, error: 'Its stored data could not be retrieved.' });
        return;
      }
      entries.push({ name: attachment.filename, data: bytes });
    } catch (error) {
      failed.push({ filename: attachment.filename, error: error instanceof Error ? error.message : String(error) });
    }
  });

  if (entries.length === 0) return { zipped: 0, failed };

  const blob = buildZip(entries);
  const url = URL.createObjectURL(blob);
  try {
    triggerBlobDownload(url, zipFilename);
  } finally {
    // Give the browser a beat to start the download before the URL is revoked;
    // revoking synchronously can cancel the save in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return { zipped: entries.length, failed };
}
