import { useEffect, useState } from 'react';
import { view } from '@forge/bridge';

export interface IssueContext {
  issueId: string;
  projectId: string;
  accountId: string;
}

interface JiraIssuePanelContext {
  accountId?: string;
  extension: {
    issue: { id: string; key: string };
    project: { id: string; key: string };
  };
}

export function useIssueContext(): { context: IssueContext | null; error: string | null } {
  const [context, setContext] = useState<IssueContext | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    view
      .getContext()
      .then((raw) => {
        if (cancelled) return;
        const ctx = raw as unknown as JiraIssuePanelContext;
        if (!ctx.accountId || !ctx.extension?.issue?.id || !ctx.extension?.project?.id) {
          setError('Could not resolve the current issue context.');
          return;
        }
        setContext({
          issueId: ctx.extension.issue.id,
          projectId: ctx.extension.project.id,
          accountId: ctx.accountId,
        });
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
