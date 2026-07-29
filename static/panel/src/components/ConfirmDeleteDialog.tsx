import { Attachment } from '../types';

export function ConfirmDeleteDialog({
  attachment,
  busy,
  onCancel,
  onConfirm,
}: {
  attachment: Attachment;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
})  {
  return (
    <div className="pb-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="pb-delete-title">
      <div className="pb-modal pb-modal-small">
        <h3 id="pb-delete-title">Delete attachment?</h3>
        <p>
          This permanently deletes <strong>{attachment.filename}</strong> from Project Bucket — the file, its generated
          preview image and its metadata cannot be recovered.
        </p>
        <div className="pb-modal-actions">
          <button className="pb-button pb-button-subtle" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="pb-button pb-button-danger" onClick={onConfirm} disabled={busy}>
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
