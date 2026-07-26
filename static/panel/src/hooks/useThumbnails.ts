import { useEffect, useState } from 'react';
import * as api from '../api/resolvers';
import { Attachment } from '../types';
import { canRenderThumbnail, generateThumbnail, thumbnailFilenameFor } from '../services/thumbnailService';
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
    api
      .getThumbnailUrls(ids)
      .then((result) => {
        if (!cancelled) setUrls(result);
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

// Attachments that predate the thumbnail feature, and every migrated
// attachment (the migration path never has a local File to render from), carry
// a null thumbnailStatus. This backfills them one at a time in the background:
// pull the bytes through the content proxy — which reads via the storage
// contract's stream(), so it works whatever the location is — render, upload,
// and record the outcome.
//
// Sequential and capped on purpose. This is invisible background repair
// competing with the user's own actions for bandwidth, so it must not fan out.
const BACKFILL_PER_PASS = 3;

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

    // Files this build can never render (Office, video, archives) are NOT
    // written back as UNSUPPORTED. canRenderThumbnail already excludes them
    // from `pending` for free on every pass, so persisting that verdict would
    // just spend a resolver call per file to learn what a Set lookup answers —
    // and would bake today's format support into old rows, so a future build
    // that can render them would skip them forever.
    if (pending.length === 0) return;

    let cancelled = false;

    (async () => {
      let changed = false;

      for (const attachment of pending) {
        if (cancelled) return;
        try {
          const content = await api.getFileContent(attachment.id);
          if (cancelled) return;
          if (!content.dataUrl) {
            // 'too-large' (the proxy's 10 MB cap) or 'not-found' — a fact about
            // these specific bytes, not the format, so it records as FAILED and
            // is not reconsidered on later passes.
            await api.recordThumbnail({
              attachmentId: attachment.id,
              thumbnailKey: null,
              thumbnailStatus: 'FAILED',
            });
            changed = true;
            continue;
          }

          const source = await (await fetch(content.dataUrl)).blob();
          const { blob, status } = await generateThumbnail(source, attachment.filename, attachment.mimeType);
          if (cancelled) return;

          if (!blob) {
            await api.recordThumbnail({ attachmentId: attachment.id, thumbnailKey: null, thumbnailStatus: status });
            changed = true;
            continue;
          }

          const [checksum] = await SequentialHashEngine.computeHashes([blob]);
          const [target] = await api.invokeResolver<any>('uploadObjects', {
            objects: [
              {
                filename: thumbnailFilenameFor(attachment.filename),
                size: blob.size,
                mimeType: 'image/jpeg',
                checksum,
              },
            ],
            issueId: attachment.issueId,
            projectId: attachment.projectId,
          });
          if (cancelled || !target?.success) continue;

          const response = await fetch(target.url, {
            method: target.method || 'PUT',
            body: blob,
            headers: target.headers || {},
          });
          if (!response.ok) throw new Error(`HTTP error ${response.status}`);

          await api.recordThumbnail({
            attachmentId: attachment.id,
            thumbnailKey: target.key,
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
