import { useEffect, useState } from 'react';
import * as api from '../api/resolvers';
import { Attachment } from '../types';
import {
  canRenderThumbnail,
  generateThumbnail,
  generateThumbnailFromUrl,
  requiresUrlSource,
  thumbnailFilenameFor,
} from '../services/thumbnailService';
import { SequentialHashEngine } from '../security/SequentialHashEngine';

// Resolves the gallery's thumbnail images in one batched round-trip.
//
// These are the small renditions generated at upload time, NOT the original
// bytes — the previous version of this hook fetched full-size originals and let
// the browser scale them down, so painting a grid of 4 MB photos downloaded
// 4 MB each. Attachments without a stored rendition are simply absent from the
// map and fall back to their file-type icon.
//
// The URLs are short-lived. The effect re-runs on every attachments refresh,
// which re-mints them long before they can expire during normal use.
//
// The resolver rejects more than 100 ids in one call, so requests are chunked.
// That limit used to be unreachable in practice — only images and PDFs had a
// rendition — but now that nearly every file gets one, an issue with 100+
// attachments would otherwise fail the whole request and drop the entire grid
// back to file-type icons.
const THUMBNAIL_URL_BATCH = 100;

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

export function useThumbnails(attachments: Attachment[]): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    const ids = attachments
      .filter((a) => a.thumbnailStatus === 'READY' && a.syncStatus !== 'QUARANTINED')
      .map((a) => a.id);

    if (ids.length === 0) {
      setUrls({});
      return;
    }

    let cancelled = false;
    Promise.all(chunk(ids, THUMBNAIL_URL_BATCH).map((batch) => api.getThumbnailUrls(batch)))
      .then((results) => {
        if (!cancelled) setUrls(Object.assign({}, ...results));
      })
      .catch(() => {
        // Thumbnails are progressive enhancement — on failure the cards fall
        // back to their file-type icons, so there is nothing to surface.
        if (!cancelled) setUrls({});
      });
    return () => {
      cancelled = true;
    };
  }, [attachments]);

  return urls;
}

// ---------------------------------------------------------------------------
// Backfill
//
// Attachments that predate the thumbnail feature, everything migrated by a
// build that could not render its format, and the categories that can only be
// rendered once their bytes are AT the storage location (video, SVG — see
// requiresUrlSource) all arrive here with no rendition. This renders them in
// the background, one file at a time, then refreshes so the new thumbnails
// appear.
//
// Sequential and capped on purpose. This is invisible background repair
// competing with the user's own actions for bandwidth, so it must not fan out.
// ---------------------------------------------------------------------------

const BACKFILL_PER_PASS = 3;

// Ceiling for pulling a whole file back down purely to render a preview of it.
// Anything larger keeps its icon rather than spending a user's bandwidth on
// background repair — and only pre-existing rows can be affected anyway, since
// the upload and migration paths render from bytes they already hold in memory,
// with no size limit at all.
const MAX_BACKFILL_FETCH_BYTES = 100 * 1024 * 1024;

// The backend content proxy's own cap (MAX_PROXY_BYTES in the resolver). Only
// relevant on the fallback path below.
const MAX_PROXY_BYTES = 10 * 1024 * 1024;

/**
 * Gets the original bytes for one attachment.
 *
 * Preferred route is a direct fetch of the storage location's presigned URL:
 * it has no size ceiling and no base64 inflation. The app provisions its
 * buckets with CORS (see bucketProvisioningService), so this is the normal
 * case. A storage location without CORS rejects that fetch, and the backend
 * content proxy — which reads through the storage contract's stream() and so
 * works anywhere — is the fallback, at the cost of its 10 MB cap.
 */
async function fetchOriginalBytes(attachment: Attachment, url: string): Promise<Blob | null> {
  if (attachment.size <= MAX_BACKFILL_FETCH_BYTES) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.blob();
    } catch {
      // CORS, or a transient network failure — fall through to the proxy.
    }
  }

  if (attachment.size > MAX_PROXY_BYTES) return null;
  const content = await api.getFileContent(attachment.id);
  if (!content.dataUrl) return null;
  return (await fetch(content.dataUrl)).blob();
}

export function useThumbnailBackfill(attachments: Attachment[], onBackfilled: () => void): void {
  useEffect(() => {
    // UNSUPPORTED rows are reconsidered, not skipped: that status only ever
    // means "this build could not render this format", so a later build that
    // adds a format picks up the old rows for free. FAILED is what's permanent
    // — it means we tried these exact bytes and they didn't work.
    const pending = attachments
      .filter(
        (a) =>
          (!a.thumbnailStatus || a.thumbnailStatus === 'UNSUPPORTED') &&
          a.syncStatus !== 'QUARANTINED' &&
          canRenderThumbnail(a.filename, a.mimeType)
      )
      .slice(0, BACKFILL_PER_PASS);

    if (pending.length === 0) return;

    let cancelled = false;

    (async () => {
      let changed = false;

      for (const attachment of pending) {
        if (cancelled) return;
        try {
          // One URL serves both routes: the URL-sourced renderers draw straight
          // from it (a <video> streams only the bytes it needs to decode the
          // first frame), and the byte-sourced ones download through it.
          const target = await api.getDownloadUrl(attachment.id, 'inline');
          if (cancelled) return;
          if (target.unavailable || !target.url) {
            // The bytes are gone. That is a fact about this row, not about the
            // format, so record it as permanent and stop reconsidering it.
            await api.recordThumbnail({
              attachmentId: attachment.id,
              thumbnailKey: null,
              thumbnailStatus: 'FAILED',
            });
            changed = true;
            continue;
          }

          const result = requiresUrlSource(attachment.filename, attachment.mimeType)
            ? await generateThumbnailFromUrl(target.url, attachment.filename, attachment.mimeType)
            : await renderFromBytes(attachment, target.url);
          if (cancelled) return;

          if (!result.blob) {
            await api.recordThumbnail({
              attachmentId: attachment.id,
              thumbnailKey: null,
              // A null status here would mean "not attempted", which would put
              // this row straight back in the queue on the next pass.
              thumbnailStatus: result.status ?? 'FAILED',
            });
            changed = true;
            continue;
          }

          const [checksum] = await SequentialHashEngine.computeHashes([result.blob]);
          const [uploadTarget] = await api.invokeResolver<any>('uploadObjects', {
            objects: [
              {
                filename: thumbnailFilenameFor(attachment.filename),
                size: result.blob.size,
                mimeType: 'image/jpeg',
                checksum,
              },
            ],
            issueId: attachment.issueId,
            projectId: attachment.projectId,
          });
          if (cancelled || !uploadTarget?.success) continue;

          const response = await fetch(uploadTarget.url, {
            method: uploadTarget.method || 'PUT',
            body: result.blob,
            headers: uploadTarget.headers || {},
          });
          if (!response.ok) throw new Error(`HTTP error ${response.status}`);

          await api.recordThumbnail({
            attachmentId: attachment.id,
            thumbnailKey: uploadTarget.key,
            thumbnailStatus: 'READY',
          });
          changed = true;
        } catch (error) {
          // Leave thumbnailStatus null so a later pass can retry — this is most
          // likely a transient network failure, not an unrenderable file.
          console.warn(`[ProjectBucket] Thumbnail backfill failed for ${attachment.id}:`, error);
        }
      }

      if (!cancelled && changed) onBackfilled();
    })();

    return () => {
      cancelled = true;
    };
  }, [attachments, onBackfilled]);
}

async function renderFromBytes(attachment: Attachment, url: string) {
  const source = await fetchOriginalBytes(attachment, url);
  // Unreachable bytes are a fact about this row, not the format: record it as
  // permanent rather than re-downloading the same file on every gallery open.
  if (!source) return { blob: null, status: 'FAILED' as const };
  return generateThumbnail(source, attachment.filename, attachment.mimeType);
}
