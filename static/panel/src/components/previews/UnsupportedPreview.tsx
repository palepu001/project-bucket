import { Attachment, classifyExtension } from '../../types';
import { FileIcon } from '../FileIcon';
import { formatBytes, formatDate } from '../../utils/format';

export function UnsupportedPreview({
  attachment,
  onDownload,
}: {
  attachment: Attachment;
  onDownload: () => void;
})  {
  return (
    <div className="pb-office-preview">
      <FileIcon category={classifyExtension(attachment.extension)} extension={attachment.extension} />
      <h4>{attachment.filename}</h4>
      <p className="pb-state-detail">No preview is available for this file type.</p>
      <dl className="pb-office-preview-meta">
        <dt>Size</dt>
        <dd>{formatBytes(attachment.size)}</dd>
        <dt>Uploaded</dt>
        <dd>{formatDate(attachment.uploadedAt)}</dd>
      </dl>
      <div className="pb-modal-actions">
        <button className="pb-button pb-button-primary" onClick={onDownload}>
          Download
        </button>
      </div>
    </div>
  );
}
