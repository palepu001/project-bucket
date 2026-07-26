// Core metadata model for a Project Bucket attachment. This is the row shape
// persisted in the `attachments` SQL table (src/db/schema.ts) and is the
// single source of truth the gallery, search, filters, previews, and the
// Teamwork Graph connector all read from. It is intentionally
// storage-location-agnostic: `objectKey` is an opaque handle the active storage
// adapter interprets, so nothing here depends on WHERE the bytes physically
// live. The location offers no "list everything" primitive, so "what
// attachments exist on this issue" can only be answered from this table.

export type AttachmentSource = 'PROJECT_BUCKET_UPLOAD' | 'JIRA_MIGRATION';

// Row lifecycle flag. `status = 'ACTIVE'` is what the gallery lists; `DELETED`
// exists so a future soft-delete can hide rows without dropping them.
// `ORPHANED` means the row's bytes were confirmed absent from the storage
// location across two consecutive consistency sweeps (see
// storageConsistencyService): the entry is hidden from the gallery, its graph
// metadata is withdrawn, but the row is kept as an audit record instead of
// being destroyed. This is a different axis from `syncStatus` below — do not
// conflate the two.
export type AttachmentStatus = 'ACTIVE' | 'DELETED' | 'ORPHANED';

// Health/processing status of the stored file, surfaced to the user as the
// status badge on each attachment row (F3 "Status badge"). A freshly stored
// attachment is READY. The remaining values are declared now so later
// milestones (malware scanning, background sync repair) can set them without
// a schema or type refactor:
//   READY        — verified in storage and fully usable
//   SCANNING     — awaiting an antivirus/content scan (future)
//   QUARANTINED  — a scan flagged it; hidden from download (future)
//   SYNC_ERROR   — the file is safe in Project Bucket, but a follow-up step
//                  (e.g. deleting the native Jira copy) did not complete
export type AttachmentSyncStatus = 'READY' | 'SCANNING' | 'QUARANTINED' | 'SYNC_ERROR';

// Whether a rendered preview image exists for this attachment. Thumbnails are
// generated in the browser at upload time (see the panel's thumbnailService)
// and stored as an ordinary object through the same storage contract as the
// file itself, so nothing here depends on WHERE the bytes live.
//   READY        — a rendition was generated and `thumbnailKey` points at it
//   UNSUPPORTED  — the build that saw this row could not render the FORMAT
//                  (Office, video, archives). Not permanent: the gallery
//                  reconsiders these, so adding a format later backfills old
//                  rows without a migration.
//   FAILED       — these specific bytes were tried and did not work (corrupt
//                  file, or too large for the content proxy). Permanent.
// Absent/null means "not attempted yet" — rows predating this feature and
// every migrated attachment start here and are filled in lazily by the gallery.
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
  // ISO timestamp of the first consistency sweep that found this row's bytes
  // missing, or null/absent when they were present. The sweep quarantines only
  // on a second consecutive miss (see storageConsistencyService), so this is the
  // "first strike" marker. Absent on freshly-constructed rows before persistence.
  missingSince?: string | null;
  // Opaque storage handle for the generated preview image, or null when none
  // exists. Interpreted only by the active storage adapter, exactly like
  // `objectKey`. Absent on freshly-constructed rows before persistence.
  thumbnailKey?: string | null;
  thumbnailStatus?: AttachmentThumbnailStatus | null;
  // S3 routing properties
  projectKey?: string | null;
  issueKey?: string | null;
  epicKey?: string | null;
  storageBucket?: string | null;
}

// Coarse category used for the filter chips in the gallery. Extension lists
// intentionally mirror the ones enumerated in the preview requirements so
// "what can be filtered" and "what can be previewed" never drift apart.
export type FileCategory =
  | 'IMAGES'
  | 'DOCUMENTS'
  | 'PDF'
  | 'OFFICE'
  | 'VIDEOS'
  | 'AUDIO'
  | 'ARCHIVES'
  | 'OTHER';

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
