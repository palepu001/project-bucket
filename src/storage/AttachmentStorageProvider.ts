// Storage capability contract. Project Bucket is a storage *management* layer,
// not a storage provider: it off-boards Jira attachments to whatever location a
// customer chooses and re-surfaces the native-Jira experience (preview, Rovo
// search, optional malware scan) for them. The bytes live wherever that
// location is — storage backend today, S3 or another cloud tomorrow, and by
// Marketplace no storage backend at all.
//
// This interface is therefore a PURE CAPABILITY CONTRACT with nothing
// platform-specific in it — no "presigned", no TTL, no '@forge/object-store'
// types. Each location is an independent adapter (see S3StorageProvider
// for today's). Resolvers, repositories, the preview path, and the Teamwork
// Graph connector depend ONLY on this contract plus SQL metadata, so a location
// swap needs zero changes above the adapter.
//
// `ref` is an opaque location handle the active adapter alone interprets;
// callers never parse it (it is the `objectKey` stored in SQL metadata). The
// `upload`/`download` methods abstract *how bytes move*: an adapter may return a
// browser-direct transfer target or a proxied one — callers just perform the
// request they are handed and never learn which.

export type ChecksumType = 'SHA1' | 'SHA256' | 'CRC32' | 'CRC32C';

export interface UploadRequest {
  /** Opaque location handle the bytes will be written to. */
  ref: string;
  length: number;
  checksum: string;
  checksumType: ChecksumType;
  mimeType?: string;
  /** Reject the write if something already lives at `ref`. */
  overwrite?: boolean;
}

/**
 * An opaque description of how a client should transfer the bytes. Callers
 * issue exactly this request (method defaults to PUT) with the file as the body
 * and never interpret the URL. A backend decides whether this is a
 * browser-direct upload or a proxied one.
 */
export interface UploadTarget {
  url: string;
  method?: string;
  headers?: Record<string, string>;
}

/** A URL a client can load to view/download the file at `ref`. */
export interface ViewUrl {
  url: string;
}

/** Raw byte stream for the file at `ref`, used by the content-proxy preview. */
export interface ByteStream {
  body: ReadableStream<Uint8Array>;
  size: number;
}

export interface ObjectSummary {
  ref: string;
  size: number;
  checksum: string;
  createdAt?: string;
}

/** Result of a per-ref existence check with three deliberately distinct states. */
export interface ExistenceResult {
  ref: string;
  /**
   * 'found'   = bytes verifiably exist.
   * 'missing' = the location authoritatively reports no bytes at this ref.
   * 'error'   = the check itself failed (transient) — callers MUST NOT treat
   *             this as "gone", or a blip would quarantine live files.
   */
  status: 'found' | 'missing' | 'error';
  summary?: ObjectSummary;
}

export interface AttachmentStorageProvider {
  /** Prepare a byte transfer into `ref`, returning the request a client should issue. */
  upload(request: UploadRequest): Promise<UploadTarget>;

  /** Return a URL a client can load to view/download the file at `ref`. */
  download(ref: string): Promise<ViewUrl>;

  /** Read the raw bytes at `ref`. Returns null if nothing is stored there. */
  stream(ref: string): Promise<ByteStream | null>;

  /** Permanently remove `ref`. Idempotent — removing a missing ref is not an error. */
  delete(ref: string): Promise<void>;

  /**
   * Batched existence/metadata lookup for a specific set of refs. There is no
   * bucket-listing here — a location may not offer one — so this answers "do
   * these exact refs exist" (used to verify an upload landed, and to reconcile
   * SQL metadata against the bytes), never "enumerate everything", which only
   * the SQL metadata can answer.
   */
  exists(refs: string[]): Promise<ExistenceResult[]>;
}
