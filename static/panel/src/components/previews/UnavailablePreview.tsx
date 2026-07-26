import { Attachment, classifyExtension } from '../../types';
import { FileIcon } from '../FileIcon';
import { formatBytes, formatDate } from '../../utils/format';

// Shown in the preview modal when the file's bytes are no longer available
// in storage backend. Provides clear, honest messaging without leaking
// internal storage errors, and gives the user an actionable "Remove entry"
// option to clean up a stale gallery entry that can no longer be previewed.
export function UnavailablePreview({
  attachment,
  onDelete,
}: {
  attachment: Attachment;
  onDelete: () => void;
}) {
  return (
    <div className="pb-unavailable-preview">
      <div className="pb-unavailable-icon" aria-hidden="true">
        <FileIcon category={classifyExtension(attachment.extension)} extension={attachment.extension} />
      </div>
      <h4>{attachment.filename}</h4>
      <p className="pb-state-detail">
        This file is no longer available because its stored data could not be
        found. You can remove this unavailable entry from Project Bucket.
      </p>
      <dl className="pb-office-preview-meta">
        <dt>Size</dt>
        <dd>{formatBytes(attachment.size)}</dd>
        <dt>Uploaded</dt>
        <dd>{formatDate(attachment.uploadedAt)}</dd>
      </dl>
      <div className="pb-modal-actions">
        <button className="pb-button pb-button-danger" onClick={onDelete}>
          Remove entry
        </button>
      </div>
    </div>
  );
}
