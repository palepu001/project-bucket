import { useEffect, useRef, useState } from 'react';
import { requestJira } from '@forge/bridge';

// Resolves accountId -> display name for the "uploaded by" column. Batches
// every unique, not-yet-resolved accountId in one request via the bulk user
// lookup endpoint rather than one request per attachment row.
export function useAccountNames(accountIds: string[]): Record<string, string> {
  const [names, setNames] = useState<Record<string, string>>({});
  const knownRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const unresolved = Array.from(new Set(accountIds)).filter((id) => id && !knownRef.current.has(id));
    if (unresolved.length === 0) return;

    let cancelled = false;
    const query = unresolved.map((id) => `accountId=${encodeURIComponent(id)}`).join('&');

    requestJira(`/rest/api/3/user/bulk?${query}&maxResults=${unresolved.length}`)
      .then((response) => response.json())
      .then((body: { values?: { accountId: string; displayName: string }[] }) => {
        if (cancelled) return;
        const next: Record<string, string> = {};
        for (const user of body.values ?? []) {
          next[user.accountId] = user.displayName;
          knownRef.current.add(user.accountId);
        }
        for (const id of unresolved) {
          if (!(id in next)) knownRef.current.add(id);
        }
        setNames((prev) => ({ ...prev, ...next }));
      })
      .catch(() => {
        // Non-fatal — the gallery falls back to showing the raw accountId.
        for (const id of unresolved) knownRef.current.add(id);
      });

    return () => {
      cancelled = true;
    };
  }, [accountIds]);

  return names;
}
