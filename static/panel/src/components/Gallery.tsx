import { Attachment } from '../types';
import { AttachmentCard } from './AttachmentCard';

export function Gallery({
  attachments,
  uploaderNames,
  thumbnails,
  onPreview,
  onDownload,
  onDelete,
}: {
  attachments: Attachment[];
  uploaderNames: Record<string, string>;
  thumbnails: Record<string, string>;
  onPreview: (attachment: Attachment) => void;
  onDownload: (attachment: Attachment) => void;
  onDelete: (attachment: Attachment) => void;
})  {
  return (
    <div className="pb-gallery">
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
