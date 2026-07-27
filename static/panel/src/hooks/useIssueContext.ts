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
    request?: { id: string; key: string; issueId?: string };
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
        
        const issueId = ctx.extension?.issue?.id || ctx.extension?.request?.issueId || ctx.extension?.request?.id;
        let projectId = ctx.extension?.project?.id;
        
        if (!ctx.accountId || !issueId) {
          setError('Could not resolve the current issue context.');
          return;
        }

        if (!projectId) {
          try {
            projectId = (await invoke('getProjectId', { issueId })) as string;
          } catch (err) {
            if (!cancelled) setError('Failed to resolve project context for this issue.');
            return;
          }
        }

        if (cancelled) return;

        setContext({
          issueId: issueId,
          projectId: projectId!,
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
