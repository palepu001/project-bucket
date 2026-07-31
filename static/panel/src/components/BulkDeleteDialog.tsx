// Confirmation for "Delete all". Bulk deletion is irreversible and issue-wide,
// so it gets its own explicit dialog rather than reusing the single-file one —
// the count is stated up front and the file list is scoped to the whole issue,
// never just the current filter.
export function BulkDeleteDialog({
  count,
  busy,
  progress,
  onCancel,
  onConfirm,
}: {
  count: number;
  busy: boolean;
  // Files deleted so far, so a large batch shows movement instead of a frozen
  // "Deleting…" button.
  progress: number;
  onCancel: () => void;
  onConfirm: () => void;
})  {
  return (
    <div className="pb-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="pb-bulk-delete-title">
      <div className="pb-modal pb-modal-small">
        <h3 id="pb-bulk-delete-title">Delete all {count} {count === 1 ? 'attachment' : 'attachments'}?</h3>
        <p>
          This permanently removes every attachment on this issue from Project Bucket — the files, their generated
          preview images and their metadata cannot be recovered. Attachments still living in Jira are not touched.
        </p>
        <div className="pb-modal-actions">
          <button className="pb-button pb-button-subtle" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="pb-button pb-button-danger" onClick={onConfirm} disabled={busy}>
            {busy ? `Deleting… ${progress}/${count}` : `Delete all ${count}`}
          </button>
        </div>
      </div>
    </div>
  );
}
