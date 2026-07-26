import { randomUUID } from 'crypto';

// Object keys are opaque UUIDs, never derived from user-supplied filenames or
// issue/project ids — avoids path-traversal-style characters ending up in a
// storage key and keeps the storage backend namespace unguessable. The
// `attachments/` prefix exists only for human legibility if the raw store is
// ever inspected; the app never lists by prefix (see AttachmentStorageProvider).
export function generateObjectKey(): string {
  return `attachments/${randomUUID()}`;
}
