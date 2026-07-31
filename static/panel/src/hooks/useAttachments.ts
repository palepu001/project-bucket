import { useCallback, useEffect, useState } from 'react';
import * as api from '../api/resolvers';
import { Attachment } from '../types';

export type LoadState = 'loading' | 'ready' | 'error';

// Category filtering (Images/Documents/PDF/...) happens client-side in
// App.tsx via classifyExtension — an issue's attachment gallery is a small,
// bounded dataset, so there is no need to plumb a multi-extension IN(...)
// clause through the resolver for it. Free-text search (filename/extension)
// still goes to SQL server-side since it can usefully use a LIKE index scan.
export function useAttachments(issueId: string | null, search: string) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [state, setState] = useState<LoadState>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // `silent` re-fetches WITHOUT flipping to the loading spinner — used after an
  // upload or delete, where we already have data on screen (and optimistic
  // placeholders) and blanking the whole gallery to a spinner would be a jarring
  // flash. The initial load and search changes stay non-silent so first paint
  // and a new query still show progress.
  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    if (!issueId) return;
    if (!opts?.silent) setState('loading');
    setErrorMessage(null);
    try {
      const result = await api.listAttachments({ issueId, search: search || undefined });
      setAttachments(result);
      setState('ready');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setState('error');
    }
  }, [issueId, search]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { attachments, state, errorMessage, refresh };
}
