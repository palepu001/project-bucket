
export function LoadingState()  {
  return (
    <div className="pb-state">
      <div className="pb-spinner" aria-hidden="true" />
      <p>Loading attachments…</p>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void })  {
  return (
    <div className="pb-state pb-state-error">
      <p>Something went wrong loading Project Bucket.</p>
      <p className="pb-state-detail">{message}</p>
      <button className="pb-button pb-button-subtle" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

export function EmptyState({ hasFilters, onClearFilters }: { hasFilters: boolean; onClearFilters: () => void })  {
  if (hasFilters) {
    return (
      <div className="pb-state">
        <p>No attachments match your search or filter.</p>
        <button className="pb-button pb-button-subtle" onClick={onClearFilters}>
          Clear search &amp; filters
        </button>
      </div>
    );
  }
  return (
    <div className="pb-state">
      <p>No attachments yet.</p>
      <p className="pb-state-detail">Use "Add Attachment" to upload files, or link existing Jira attachments when prompted.</p>
    </div>
  );
}
