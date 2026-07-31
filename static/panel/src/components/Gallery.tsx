import { Attachment } from '../types';
import { AttachmentCard } from './AttachmentCard';
import { AttachmentRow } from './AttachmentRow';
import { UploadProgressCard, UploadProgressRow } from './UploadProgressItem';
import { UploadItemProgress } from '../services/uploadService';
import { ViewMode } from './Toolbar';

export function Gallery({
  attachments,
  uploaderNames,
  thumbnails,
  viewMode,
  uploads,
  onPreview,
  onDownload,
  onDelete,
}: {
  attachments: Attachment[];
  uploaderNames: Record<string, string>;
  thumbnails: Record<string, string>;
  viewMode: ViewMode;
  // In-progress uploads, rendered as placeholders at the top of the gallery so
  // a new file appears the instant it is picked (see uploadService).
  uploads: UploadItemProgress[];
  onPreview: (attachment: Attachment) => void;
  onDownload: (attachment: Attachment) => void;
  onDelete: (attachment: Attachment) => void;
})  {
  if (viewMode === 'list') {
    return (
      <div className="pb-list">
        <div className="pb-list-head" role="row">
          <span className="pb-row-name">Name</span>
          <span className="pb-row-size">Size</span>
          <span className="pb-row-date">Date added</span>
          <span className="pb-row-actions" aria-hidden="true" />
        </div>
        {uploads.map((upload) => (
          <UploadProgressRow key={upload.id} item={upload} />
        ))}
        {attachments.map((attachment) => (
          <AttachmentRow
            key={attachment.id}
            attachment={attachment}
            uploaderName={uploaderNames[attachment.uploadedBy] ?? attachment.uploadedBy}
            thumbnailUrl={thumbnails[attachment.id]}
            onPreview={() => onPreview(attachment)}
            onDownload={() => onDownload(attachment)}
            onDelete={() => onDelete(attachment)}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="pb-gallery">
      {uploads.map((upload) => (
        <UploadProgressCard key={upload.id} item={upload} />
      ))}
      {attachments.map((attachment) => (
        <AttachmentCard
          key={attachment.id}
          attachment={attachment}
          uploaderName={uploaderNames[attachment.uploadedBy] ?? attachment.uploadedBy}
          thumbnailUrl={thumbnails[attachment.id]}
          onPreview={() => onPreview(attachment)}
          onDownload={() => onDownload(attachment)}
          onDelete={() => onDelete(attachment)}
        />
      ))}
    </div>
  );
}
