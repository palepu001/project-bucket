import { randomUUID } from 'crypto';

const SANITIZE_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function sanitizeSegment(segment: string | null | undefined): string {
  if (!segment) return 'invalid';
  return SANITIZE_REGEX.test(segment) ? segment : 'invalid';
}

export interface StorageKeyContext {
  cloudId: string;
  projectKey: string;
  epicKey: string | null;
  issueKey: string;
}

export function generateStorageKey(context: StorageKeyContext, uuid?: string): string {
  const safeCloudId = sanitizeSegment(context.cloudId);
  const safeProjectKey = sanitizeSegment(context.projectKey);
  const safeEpicKey = sanitizeSegment(context.epicKey || 'none');
  const safeIssueKey = sanitizeSegment(context.issueKey);
  const fileId = uuid || randomUUID();

  return `pb/v1/instances/${safeCloudId}/projects/${safeProjectKey}/epics/${safeEpicKey}/issues/${safeIssueKey}/files/${fileId}`;
}

export function generateThumbnailKey(fileKey: string): string {
  return `${fileKey}.thumb`;
}
