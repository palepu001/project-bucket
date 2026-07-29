import { invoke } from '@forge/bridge';
import { Attachment, MigrationRun, Session } from '../types';

// Thin, typed wrappers around every backend resolver this bundle calls. Kept
// in one file so the resolver contract (src/resolvers/index.ts on the
// backend) has exactly one place on this side that has to stay in sync.
//
// @forge/bridge's `invoke` is typed to return `T | { body: T; metadata }` —
// the wrapped shape only ever appears at runtime when a `metadata` option is
// explicitly requested, which none of these calls do, so the plain-T branch
// is what always comes back here. The cast makes that (accurate) assumption
// explicit instead of leaking the union into every call site.
export function invokeResolver<T>(functionKey: string, payload?: Record<string, unknown>): Promise<T> {
  return invoke(functionKey, payload) as Promise<T>;
}

function callResolver<T>(functionKey: string, payload?: Record<string, unknown>): Promise<T> {
  return invoke(functionKey, payload) as Promise<T>;
}

export function listAttachments(params: { issueId: string; search?: string; extension?: string }): Promise<Attachment[]> {
  return callResolver('listAttachments', params);
}

// The resolver returns `unavailable: true` (with `url: null`) when the
// object's bytes are no longer in the store — platform-side data loss,
// EAP retention, etc. The frontend shows a friendly "file unavailable"
// state instead of surfacing a raw storage backend error.
export interface DownloadUrlResult {
  url: string | null;
  filename: string;
  mimeType: string;
  size: number;
  unavailable?: boolean;
}

/**
 * `disposition` picks what the minted URL does when the browser loads it:
 *   'inline'     (default) — render it, for the preview surfaces.
 *   'attachment'           — save it under the attachment's real filename.
 *
 * The browser cannot make this choice itself: an `<a download>` hint only
 * applies to same-origin URLs, and the storage location is always cross-origin
 * to this iframe. So the Download action must ask for 'attachment' and let the
 * storage location set Content-Disposition.
 */
export function getDownloadUrl(
  attachmentId: string,
  disposition: 'inline' | 'attachment' = 'inline'
): Promise<DownloadUrlResult> {
  return callResolver('getDownloadUrl', { attachmentId, disposition });
}

// A read-only comparison between the SQL metadata for this issue and the
// corresponding storage backend keys. storage backend cannot enumerate a
// bucket, so this verifies every key Project Bucket has recorded rather than
// claiming to list unrelated objects.
export interface StorageAuditItem {
  attachmentId: string;
  filename: string;
  objectKey: string;
  source: Attachment['source'];
  expectedSize: number;
  expectedChecksum: string;
  exists: boolean;
  storedSize: number | null;
  storedChecksum: string | null;
  metadataMatches: boolean;
}

export function getStorageAudit(issueId: string): Promise<StorageAuditItem[]> {
  return callResolver('getStorageAudit', { issueId });
}

// Removes every copy Project Bucket owns: the stored object, its generated
// preview image, the metadata row and the Teamwork Graph object. Nothing in
// Jira is touched — a native attachment the customer chose not to link stays
// exactly where they left it.
export function deleteAttachment(attachmentId: string): Promise<{ success: true }> {
  return callResolver('deleteAttachment', { attachmentId });
}

// URLs for the small generated renditions the gallery grid paints, in one
// round-trip. Distinct from getDownloadUrl, which returns the ORIGINAL bytes.
// Attachments without a stored rendition are absent from the returned map.
export function getThumbnailUrls(attachmentIds: string[]): Promise<Record<string, string>> {
  return callResolver('getThumbnailUrls', { attachmentIds });
}

// Bytes proxied through the backend as a base64 data URL. Reads via the storage
// contract's stream(), so it works whatever the storage location is — which is
// why the thumbnail backfill uses it rather than fetching a URL directly.
// `error` is 'too-large' (the proxy's 10 MB cap) or 'not-found'.
export interface FileContentResult {
  dataUrl?: string;
  error?: 'too-large' | 'not-found';
}

export function getFileContent(attachmentId: string): Promise<FileContentResult> {
  return callResolver('getFileContent', { attachmentId });
}

export function recordThumbnail(params: {
  attachmentId: string;
  thumbnailKey: string | null;
  thumbnailStatus: NonNullable<Attachment['thumbnailStatus']>;
}): Promise<{ success: true }> {
  return callResolver('recordThumbnail', params);
}

export interface RecordAttachmentInput {
  key: string;
  filename: string;
  size: number;
  mimeType: string;
  checksum: string;
  thumbnailKey?: string | null;
  thumbnailStatus?: Attachment['thumbnailStatus'];
}

export function recordAttachments(params: {
  issueId: string;
  projectId: string;
  items: RecordAttachmentInput[];
}): Promise<Attachment[]> {
  return callResolver('recordAttachments', params);
}

export function getMigrationDiagnostics(issueId: string): Promise<MigrationRun[]> {
  return callResolver('getMigrationDiagnostics', { issueId });
}

export function retryMigration(migrationId: string): Promise<MigrationRun> {
  return callResolver('retryMigration', { migrationId });
}

export function pollPendingSession(issueId: string): Promise<Session | null> {
  return callResolver('pollPendingSession', { issueId });
}
