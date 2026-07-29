import { useEffect, useState } from 'react';
import { Attachment, classifyExtension } from '../types';
import { FileIcon } from './FileIcon';
import { formatBytes, formatDate } from '../utils/format';

const WARNING_HINTS: Partial<Record<Attachment['syncStatus'], string>> = {
  SYNC_ERROR: 'Stored safely in Project Bucket, but the native Jira copy may still exist. Retry from Diagnostics.',
  QUARANTINED: 'This file has been quarantined and cannot be previewed or downloaded.',
};

export function AttachmentCard({
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
})  {
  const category = classifyExtension(attachment.extension);
  const warningHint = WARNING_HINTS[attachment.syncStatus];

  // A presigned thumbnail URL can stop working while the panel is open — it
  // expires after an hour, and the object can be removed underneath us. Without
  // this the card would paint the browser's broken-image glyph; falling back to
  // the file-type icon keeps the grid looking deliberate either way. Reset on
  // url change so a re-minted URL gets a fresh chance.
  const [thumbnailBroken, setThumbnailBroken] = useState(false);
  useEffect(() => setThumbnailBroken(false), [thumbnailUrl]);
  const showThumbnail = Boolean(thumbnailUrl) && !thumbnailBroken;

  return (
    <div className="pb-card" title={`${attachment.filename}\n${formatBytes(attachment.size)} · added by ${uploaderName}`}>
      <div className="pb-card-preview" onClick={onPreview} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onPreview()} aria-label={`Preview ${attachment.filename}`}>
        {showThumbnail ? (
          <img
            className="pb-card-thumb"
            src={thumbnailUrl}
            alt=""
            loading="lazy"
            onError={() => setThumbnailBroken(true)}
          />
        ) : (
          <FileIcon category={category} extension={attachment.extension} />
        )}
      </div>

      <div className="pb-card-footer">
        <span className="pb-card-name" title={attachment.filename}>{attachment.filename}</span>
        <span className="pb-card-date">{formatDate(attachment.uploadedAt)}</span>
      </div>

      {warningHint && (
        <span className="pb-card-warning" role="img" aria-label="Attention needed" title={warningHint}>
          !
        </span>
      )}

      <div className="pb-card-actions">
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
