import { useEffect, useState } from 'react';
import { Attachment, classifyExtension } from '../types';
import * as api from '../api/resolvers';
import { LoadingState, ErrorState } from './States';
import { ImagePreview } from './previews/ImagePreview';
import { CsvPreview } from './previews/CsvPreview';
import { TextPreview } from './previews/TextPreview';
import { VideoPreview } from './previews/VideoPreview';
import { AudioPreview } from './previews/AudioPreview';
import { OfficePreview } from './previews/OfficePreview';
import { RenditionPreview } from './previews/RenditionPreview';
import { UnsupportedPreview } from './previews/UnsupportedPreview';
import { UnavailablePreview } from './previews/UnavailablePreview';

export function PreviewModal({
  attachment,
  onClose,
  onDownload,
  onDelete,
}: {
  attachment: Attachment;
  onClose: () => void;
  onDownload: (attachment: Attachment) => void;
  onDelete: (attachment: Attachment) => void;
})  {
  const [url, setUrl] = useState<string | null>(null);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The rendition generated at upload time. PDFs are displayed from it outright,
  // and videos use it as a poster. Failure is silent by design — every category
  // below has a working fallback that doesn't need it.
  useEffect(() => {
    if (attachment.thumbnailStatus !== 'READY') {
      setThumbnailUrl(null);
      return;
    }
    let cancelled = false;
    api
      .getThumbnailUrls([attachment.id])
      .then((result) => {
        if (!cancelled) setThumbnailUrl(result[attachment.id] ?? null);
      })
      .catch(() => {
        if (!cancelled) setThumbnailUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [attachment.id, attachment.thumbnailStatus]);

  useEffect(() => {
    let cancelled = false;
    api
      .getDownloadUrl(attachment.id)
      .then((result) => {
        if (cancelled) return;
        // The backend returns `unavailable: true` when the object's bytes are
        // no longer in the store (platform-side data loss, EAP retention, etc.).
        if (result.unavailable) {
          setUnavailable(true);
        } else {
          setUrl(result.url);
        }
      })
      .catch(() => {
        // Surface a human-readable message, never the raw storage backend
        // internal error string.
        if (!cancelled) setError('Could not load this file for preview. Please try again later.');
      });
    return () => {
      cancelled = true;
    };
  }, [attachment.id]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const category = classifyExtension(attachment.extension);

  function renderBody()  {
    // File is genuinely missing from storage backend — show a friendly,
    // actionable "unavailable" state instead of a raw error or spinner.
    if (unavailable) return <UnavailablePreview attachment={attachment} onDelete={() => onDelete(attachment)} />;
    if (error) return <ErrorState message={error} onRetry={onClose} />;
    if (!url) return <LoadingState />;

    switch (category) {
      case 'IMAGES':
        return <ImagePreview url={url} alt={attachment.filename} />;
      case 'PDF':
        // Displayed from the page-1 image rendered at upload time, so the view
        // path needs no pdf.js, no worker and no canvas — only an <img>, which
        // is the one delivery mechanism that has always worked here. Without a
        // rendition there is nothing to show, so fall through to the
        // metadata + Download layout rather than an empty frame.
        if (!thumbnailUrl) {
          return <UnsupportedPreview attachment={attachment} onDownload={() => onDownload(attachment)} />;
        }
        return (
          <RenditionPreview
            url={thumbnailUrl}
            alt={attachment.filename}
            caption="Showing page 1 — download the file to read all pages."
          />
        );
      case 'DOCUMENTS':
        if (attachment.extension.toLowerCase() === 'csv') {
          return <CsvPreview attachmentId={attachment.id} />;
        }
        return <TextPreview attachmentId={attachment.id} extension={attachment.extension} />;
      case 'VIDEOS':
        return <VideoPreview url={url} mimeType={attachment.mimeType} poster={thumbnailUrl ?? undefined} />;
      case 'AUDIO':
        return <AudioPreview url={url} mimeType={attachment.mimeType} waveform={thumbnailUrl ?? undefined} />;
      case 'OFFICE':
        // Neither Forge nor the browser can render an Office document, but the
        // rendition we generated for it is a real look at its contents — the
        // page image the authoring application embedded, or the document's own
        // opening text. Showing that beats the metadata card by a distance;
        // the card is still the fallback when there is no rendition.
        if (thumbnailUrl) {
          return (
            <RenditionPreview
              url={thumbnailUrl}
              alt={attachment.filename}
              caption="Preview of the document — download it to open the full file."
            />
          );
        }
        return <OfficePreview attachment={attachment} url={url} onDownload={() => onDownload(attachment)} />;
      case 'ARCHIVES':
        // The rendition for an archive is its member listing, which is exactly
        // what someone opening a .zip preview wants to see.
        if (thumbnailUrl) {
          return (
            <RenditionPreview
              url={thumbnailUrl}
              alt={`Contents of ${attachment.filename}`}
              caption="Contents of the archive — download it to extract the files."
            />
          );
        }
        return <UnsupportedPreview attachment={attachment} onDownload={() => onDownload(attachment)} />;
      default:
        // Files with no known extension but a text MIME type still have
        // readable content, and the text viewer is the honest way to show it.
        if (attachment.mimeType?.startsWith('text/')) {
          return <TextPreview attachmentId={attachment.id} extension={attachment.extension} />;
        }
        return <UnsupportedPreview attachment={attachment} onDownload={() => onDownload(attachment)} />;
    }
  }

  return (
    <div className="pb-modal-overlay" onClick={onClose}>
      <div
        className="pb-modal pb-modal-large"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Preview of ${attachment.filename}`}
      >
        <div className="pb-modal-header">
          <h3 title={attachment.filename}>{attachment.filename}</h3>
          <div className="pb-modal-header-actions">
            <button className="pb-button pb-button-subtle" onClick={() => onDownload(attachment)}>
              Download
            </button>
            <button className="pb-button pb-button-subtle" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
        <div className="pb-modal-preview-body">{renderBody()}</div>
      </div>
    </div>
  );
}
