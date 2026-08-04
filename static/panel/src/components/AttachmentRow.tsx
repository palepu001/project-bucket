import { useEffect, useState } from 'react';
import { Attachment, classifyExtension } from '../types';
import { FileIcon } from './FileIcon';
import { formatBytes, formatDate } from '../utils/format';
import { canRenderThumbnail } from '../services/thumbnailService';

const WARNING_HINTS: Partial<Record<Attachment['syncStatus'], string>> = {
  SYNC_ERROR: 'Stored safely in Project Bucket, but the native Jira copy may still exist. Retry from Diagnostics.',
  QUARANTINED: 'This file has been quarantined and cannot be previewed or downloaded.',
};

export function AttachmentRow({
  attachment,
  uploaderName,
  thumbnailUrl,
  onPreview,
  onDownload,
  onDelete,
}: {
  attachment: Attachment;
  uploaderName: string;
  thumbnailUrl?: string;
  onPreview: () => void;
  onDownload: () => void;
  onDelete: () => void;
}) {
  const category = classifyExtension(attachment.extension);
  const warningHint = WARNING_HINTS[attachment.syncStatus];

  const [thumbnailBroken, setThumbnailBroken] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);

  useEffect(() => {
    setThumbnailBroken(false);
    setImageLoaded(false);
  }, [thumbnailUrl]);

  const isExpectingThumbnail =
    canRenderThumbnail(attachment.filename, attachment.mimeType) &&
    attachment.thumbnailStatus !== 'UNSUPPORTED' &&
    attachment.thumbnailStatus !== 'FAILED' &&
    !thumbnailBroken;

  const showSkeleton = isExpectingThumbnail && (!thumbnailUrl || !imageLoaded);
  const showThumbnail = Boolean(thumbnailUrl) && !thumbnailBroken;

  return (
    <div className="pb-row" title={`${attachment.filename}\n${formatBytes(attachment.size)} · added by ${uploaderName}`}>
      <div
        className="pb-row-name"
        onClick={onPreview}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && onPreview()}
        aria-label={`Preview ${attachment.filename}`}
      >
        <span className="pb-row-thumb">
          {showSkeleton ? (
            <div className="pb-skeleton pb-row-thumb-skeleton" aria-hidden="true" />
          ) : showThumbnail ? (
            <img
              className={imageLoaded ? 'pb-thumb-loaded' : 'pb-thumb-loading'}
              src={thumbnailUrl}
              alt=""
              loading="lazy"
              onLoad={() => setImageLoaded(true)}
              onError={() => setThumbnailBroken(true)}
            />
          ) : (
            <FileIcon category={category} extension={attachment.extension} />
          )}
        </span>

        <span className="pb-row-filename">{attachment.filename}</span>
        {warningHint && (
          <span className="pb-row-warning" role="img" aria-label="Attention needed" title={warningHint}>
            !
          </span>
        )}
      </div>
      <div className="pb-row-size">{formatBytes(attachment.size)}</div>
      <div className="pb-row-date">{formatDate(attachment.uploadedAt)}</div>
      <div className="pb-row-actions">
        <button className="pb-icon-button" onClick={onDownload} aria-label={`Download ${attachment.filename}`} title="Download">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M8 2v7m0 0 3-3M8 9 5 6M3 12.5h10"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          className="pb-icon-button pb-icon-button-danger"
          onClick={onDelete}
          aria-label={`Delete ${attachment.filename}`}
          title="Delete"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M2.5 4.5h11M6.5 4V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M4 4.5l.6 8a1 1 0 0 0 1 .93h4.8a1 1 0 0 0 1-.93l.6-8M6.5 7v4M9.5 7v4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
