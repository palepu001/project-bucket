// Mirrors src/types/attachment.ts and src/types/migration.ts on the backend.
// Duplicated rather than shared because this bundle (esbuild, static/panel)
// and the backend (Forge's own bundler, src/) are built independently — see
// the note in static/attachment-watcher/src/migrationClient.ts for the same
// tradeoff made a second time for the same reason.

export type AttachmentSource = 'PROJECT_BUCKET_UPLOAD' | 'JIRA_MIGRATION';
export type AttachmentStatus = 'ACTIVE' | 'DELETED';

// Mirrors AttachmentSyncStatus in src/types/attachment.ts — the health status
// rendered as each row's status badge. Only READY / SYNC_ERROR are produced
// today; the others are reserved for future scanning milestones.
export type AttachmentSyncStatus = 'READY' | 'SCANNING' | 'QUARANTINED' | 'SYNC_ERROR';

// Mirrors AttachmentThumbnailStatus in src/types/attachment.ts. null/undefined
// means "not attempted yet" and is what triggers the gallery's lazy backfill
// for rows predating this feature and for migrated attachments.
export type AttachmentThumbnailStatus = 'READY' | 'UNSUPPORTED' | 'FAILED';

export interface Attachment {
  id: string;
  issueId: string;
  projectId: string;
  filename: string;
  extension: string;
  mimeType: string;
  size: number;
  checksum: string;
  objectKey: string;
  uploadedBy: string;
  uploadedAt: string;
  lastModified: string;
  status: AttachmentStatus;
  syncStatus: AttachmentSyncStatus;
  source: AttachmentSource;
  jiraAttachmentId: string | null;
  thumbnailKey?: string | null;
  thumbnailStatus?: AttachmentThumbnailStatus | null;
}

export type FileCategory = 'IMAGES' | 'DOCUMENTS' | 'PDF' | 'OFFICE' | 'VIDEOS' | 'AUDIO' | 'ARCHIVES' | 'OTHER';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp', 'tiff', 'tif']);
const DOCUMENT_EXTENSIONS = new Set(['txt', 'md', 'json', 'xml', 'yaml', 'yml', 'log', 'csv', 'html', 'htm']);
const PDF_EXTENSIONS = new Set(['pdf']);
const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'odt', 'ods', 'odp']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg']);
const ARCHIVE_EXTENSIONS = new Set(['zip', 'tar', 'gz', 'tgz', 'rar', '7z', 'bz2']);

export function classifyExtension(extension: string): FileCategory {
  const ext = extension.toLowerCase().replace(/^\./, '');
  if (IMAGE_EXTENSIONS.has(ext)) return 'IMAGES';
  if (PDF_EXTENSIONS.has(ext)) return 'PDF';
  if (OFFICE_EXTENSIONS.has(ext)) return 'OFFICE';
  if (VIDEO_EXTENSIONS.has(ext)) return 'VIDEOS';
  if (AUDIO_EXTENSIONS.has(ext)) return 'AUDIO';
  if (ARCHIVE_EXTENSIONS.has(ext)) return 'ARCHIVES';
  if (DOCUMENT_EXTENSIONS.has(ext)) return 'DOCUMENTS';
  return 'OTHER';
}

export function extensionOf(filename: string): string {
  const idx = filename.lastIndexOf('.');
  if (idx === -1 || idx === filename.length - 1) return '';
  return filename.slice(idx + 1).toLowerCase();
}

export type SessionStatus = 'PENDING' | 'NOTIFIED' | 'RESOLVED' | 'DISMISSED';

export interface SessionItem {
  id: string;
  sessionId: string;
  jiraAttachmentId: string;
  filename: string;
  size: number;
  mimeType: string;
  authorAccountId: string;
  detectedAt: string;
}

export interface Session {
  id: string;
  issueId: string;
  projectId: string;
  status: SessionStatus;
  createdAt: string;
  lastEventAt: string;
  notifiedAt: string | null;
  resolvedAt: string | null;
  items: SessionItem[];
}

// See src/types/migration.ts for the full semantics. PARTIAL_FAILURE = every
// file is safely in Project Bucket but a native Jira copy could not be deleted;
// FAILED = the session was aborted before any native copy was touched.
export type MigrationRunStatus = 'RUNNING' | 'COMPLETED' | 'PARTIAL_FAILURE' | 'FAILED';

export type MigrationItemStatus =
  | 'PENDING'
  | 'UPLOADING'
  | 'STAGED'
  | 'SUCCEEDED'
  | 'SOURCE_DELETE_FAILED'
  | 'SOURCE_MISSING'
  // Failed validation, so it may not go to the storage location. Withdrawn from
  // the session rather than failing it — the file stays in Jira, untouched, and
  // the rest of the session migrates. Permanent: retrying cannot change it.
  | 'BLOCKED'
  | 'FAILED';

export interface MigrationItem {
  id: string;
  migrationId: string;
  jiraAttachmentId: string;
  filename: string;
  status: MigrationItemStatus;
  errorMessage: string | null;
  attachmentId: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface MigrationRun {
  id: string;
  issueId: string;
  projectId: string;
  sessionId: string | null;
  requestedCount: number;
  migratedCount: number;
  failedCount: number;
  status: MigrationRunStatus;
  startedAt: string;
  completedAt: string | null;
  triggeredBy: string;
  items: MigrationItem[];
}
