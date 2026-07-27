import { useEffect, useState } from 'react';
import { view, invoke } from '@forge/bridge';

export interface IssueContext {
  issueId: string;
  projectId: string;
  accountId: string;
}

interface JiraIssuePanelContext {
  accountId?: string;
  extension: {
    issue?: { id: string; key: string };
    request?: { key: string };
    project?: { id: string; key: string };
  };
}

export function useIssueContext(): { context: IssueContext | null; error: string | null } {
  const [context, setContext] = useState<IssueContext | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    view
      .getContext()
      .then(async (raw) => {
        if (cancelled) return;
        const ctx = raw as unknown as JiraIssuePanelContext;

        const issueId = ctx.extension?.issue?.id;
        const projectId = ctx.extension?.project?.id;
        // JSM's portalRequestDetailPanel only exposes the issue key (e.g. "SUP-1"), not the
        // numeric issue id or project id — those need a backend lookup.
        const issueIdOrKey = issueId || ctx.extension?.request?.key;

        if (!ctx.accountId || !issueIdOrKey) {
          setError('Could not resolve the current issue context.');
          return;
        }

        if (issueId && projectId) {
          setContext({ issueId, projectId, accountId: ctx.accountId });
          return;
        }

        try {
          const resolved = (await invoke('resolveIssueContext', { issueIdOrKey })) as {
            issueId: string;
            projectId: string;
          };
          if (cancelled) return;
          setContext({ issueId: resolved.issueId, projectId: resolved.projectId, accountId: ctx.accountId });
        } catch (err) {
          if (!cancelled) setError('Failed to resolve project context for this issue.');
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { context, error };
}
