import { route } from '@forge/api';
import { requestJiraSmart } from '../util/jiraApi';

/**
 * Verifies that the Jira issue exists and is accessible.
 *
 * Uses requestJiraSmart(): checks asUser() during synchronous resolver calls,
 * and transparently falls back to asApp() when running in background worker contexts
 * where no user token is available.
 */
export async function verifyIssueAccess(issueId: string): Promise<void> {
  const response = await requestJiraSmart(route`/rest/api/3/issue/${issueId}?fields=id`);
  if (!response.ok) {
    throw new Error(`Unauthorized or missing issue ${issueId}`);
  }
}

