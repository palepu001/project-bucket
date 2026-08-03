import api, { route } from '@forge/api';

/**
 * Verifies that the current Forge invocation user can see the Jira issue.
 *
 * This intentionally uses asUser(): Jira performs the same browse/security
 * checks it would perform for the user in the product UI. Upload and migration
 * write paths call this before minting storage URLs, recording metadata, or
 * deleting native attachments so a forged resolver call cannot operate on an
 * issue the caller cannot browse.
 */
export async function verifyIssueAccess(issueId: string): Promise<void> {
  const response = await api.asUser().requestJira(route`/rest/api/3/issue/${issueId}?fields=id`);
  if (!response.ok) {
    throw new Error(`Unauthorized or missing issue ${issueId}`);
  }
}
