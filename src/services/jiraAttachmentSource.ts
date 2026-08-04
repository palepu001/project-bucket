import api, { route } from '@forge/api';
import { requestJiraSmart } from '../util/jiraApi';

// Everything this app needs from Jira's *native* attachment API, isolated in
// one file. Note deliberately absent: a "download attachment content"
// function. storage backend's backend SDK only mints presigned URLs (see
// storage/AttachmentStorageProvider.ts) — there is no backend primitive to
// push a Buffer into it — so the actual bytes for a Jira→Project Bucket
// migration are read by the BROWSER (via requestJira from '@forge/bridge' in
// static/attachment-watcher) and handed straight to the upload bridge call.
// This file only implements the two things that must run under Forge's
// trust boundary: deleting the native copy (only ever called after the
// resolver has verified the migrated copy exists) and resolving a project id
// when a caller only has an issue id.

export interface JiraAttachmentMetadata {
  id: string;
  filename: string;
  size: number;
  mimeType: string;
}

/**
 * Deletes a native Jira attachment. Callers MUST have already verified the
 * migrated copy exists in storage backend before calling this — see
 * services/migrationService.ts, which is the only caller.
 */
export async function deleteNativeAttachment(attachmentId: string): Promise<void> {
  const response = await requestJiraSmart(route`/rest/api/3/attachment/${attachmentId}`, {
    method: 'DELETE',
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Failed to delete native Jira attachment ${attachmentId}: HTTP ${response.status}`);
  }
}

export async function getAttachmentMetadata(attachmentId: string): Promise<JiraAttachmentMetadata | null> {
  const response = await requestJiraSmart(route`/rest/api/3/attachment/${attachmentId}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Failed to load native Jira attachment ${attachmentId}: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { id: string; filename: string; size: number; mimeType: string };
  return { id: body.id, filename: body.filename, size: body.size, mimeType: body.mimeType };
}

/** Used by the product trigger, which has no user context — asApp() only. */
export async function getIssueProjectIdAsApp(issueId: string): Promise<string> {
  const response = await api.asApp().requestJira(route`/rest/api/3/issue/${issueId}?fields=project`);
  if (!response.ok) {
    throw new Error(`Failed to resolve project for issue ${issueId}: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { fields: { project: { id: string } } };
  return body.fields.project.id;
}

/** Used by resolvers to stream download attachment content. */
export async function downloadNativeAttachmentStream(attachmentId: string): Promise<any> {
  const response = await requestJiraSmart(route`/rest/api/3/attachment/content/${attachmentId}`);
  if (!response.ok) {
    throw new Error(`Failed to download native attachment content ${attachmentId}: HTTP ${response.status}`);
  }
  return (response as any).body;
}

